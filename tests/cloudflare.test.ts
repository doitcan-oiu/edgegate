import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfApi, cfGraphql } from '../worker/cloudflare';
import { ApiError } from '../worker/lib/errors';
import type { Env } from '../worker/types';

const env = { CF_API_TOKEN: 'private-test-token' } as Env;
const fetchMock = vi.fn<typeof fetch>();
const apiResponse = () => Response.json({ success: true, result: [{ id: 'log-1' }] });
function failure(status: number) {
  const response = new Response(`<html>upstream failure with ${env.CF_API_TOKEN}</html>`, { status });
  return { response, cancel: vi.spyOn(response.body!, 'cancel') };
}
async function rejection(pending: Promise<unknown>) {
  const result = pending.catch(error => error);
  await vi.runAllTimersAsync();
  return await result as ApiError;
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe('Cloudflare read retries', () => {
  it.each([500, 502, 503, 599])('retries HTTP %s and returns the next successful response', async status => {
    const failed = failure(status);
    fetchMock.mockResolvedValueOnce(failed.response).mockResolvedValueOnce(apiResponse());
    const pending = cfApi(env, '/logs');
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ success: true, result: [{ id: 'log-1' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failed.cancel).toHaveBeenCalledOnce();
  });

  it('waits 250ms then 500ms and gives each attempt a fresh 20-second deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const failures = [failure(500), failure(502)];
    fetchMock.mockResolvedValueOnce(failures[0].response).mockResolvedValueOnce(failures[1].response).mockResolvedValueOnce(apiResponse());
    const pending = cfApi(env, '/logs');
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failures[0].cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).result).toEqual([{ id: 'log-1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls).toEqual([[20000], [20000], [20000]]);
    expect(new Set(fetchMock.mock.calls.map(([, options]) => options!.signal)).size).toBe(3);
    expect(failures[1].cancel).toHaveBeenCalledOnce();
  });

  it.each(['GET', 'get', 'HEAD'])('stops %s after three failed attempts with a safe, clear error', async method => {
    const failures = [failure(500), failure(502), failure(503)];
    failures.forEach(({ response }) => fetchMock.mockResolvedValueOnce(response));
    const error = await rejection(cfApi(env, '/logs', { method }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'cloudflare_api_error' });
    expect(error.message).toContain('503');
    expect(error.message).toContain('已重试 2 次（共 3 次请求）');
    expect(error.message).not.toContain('<html>');
    expect(error.message).not.toContain(env.CF_API_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    failures.forEach(({ cancel }) => expect(cancel).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [401, 502, 'cloudflare_permission_denied'],
    [403, 502, 'cloudflare_permission_denied'],
    [404, 404, 'cloudflare_not_found'],
    [409, 409, 'cloudflare_api_error'],
    [429, 429, 'cloudflare_rate_limited'],
  ])('does not retry HTTP %s', async (upstreamStatus, status, code) => {
    const failed = failure(upstreamStatus as number);
    fetchMock.mockResolvedValueOnce(failed.response);
    const error = await rejection(cfApi(env, '/logs'));
    expect(error).toMatchObject({ status, code });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(failed.cancel).toHaveBeenCalledOnce();
    expect(error.message).not.toContain(env.CF_API_TOKEN);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not replay a %s management operation on HTTP 503', async method => {
    const failed = failure(503);
    fetchMock.mockResolvedValueOnce(failed.response);
    const error = await rejection(cfApi(env, '/providers', { method, body: JSON.stringify({ name: 'provider' }) }));
    expect(error).toMatchObject({ status: 502, code: 'cloudflare_api_error' });
    expect(error.message).not.toContain('已重试');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(failed.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [JSON.stringify({ success: false, errors: [{ message: 'private-test-token' }] }), 'cloudflare_api_error'],
    ['<html>private-test-token</html>', 'cloudflare_invalid_response'],
  ])('does not retry an HTTP 200 API failure or invalid JSON', async (body, code) => {
    fetchMock.mockResolvedValueOnce(new Response(body));
    const error = await rejection(cfApi(env, '/logs'));
    expect(error).toMatchObject({ status: 502, code });
    expect(error.message).not.toContain(env.CF_API_TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('continues retrying even when releasing a failed body rejects', async () => {
    const failed = failure(503);
    failed.cancel.mockRejectedValueOnce(new Error('stream already closed'));
    fetchMock.mockResolvedValueOnce(failed.response).mockResolvedValueOnce(apiResponse());
    const pending = cfApi(env, '/logs');
    await vi.runAllTimersAsync();
    expect((await pending).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([new Error('network private-test-token'), new DOMException('timeout private-test-token', 'TimeoutError')])('does not retry connection failures or timeouts', async failure => {
    fetchMock.mockRejectedValueOnce(failure);
    const error = await rejection(cfApi(env, '/logs'));
    expect(error).toMatchObject({ status: 502, code: 'cloudflare_connection_error' });
    expect(error.message).not.toContain(env.CF_API_TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('Cloudflare GraphQL query retries', () => {
  it.each(['query { viewer { accounts { id } } }', '{ __type(name: "Query") { name } }', '# analytics query\nquery Analytics { viewer { accounts { id } } }'])('retries read-only GraphQL POST queries', async query => {
    fetchMock.mockResolvedValueOnce(failure(502).response).mockResolvedValueOnce(failure(503).response).mockResolvedValueOnce(Response.json({ data: { count: 7 } }));
    const pending = cfGraphql(env, query);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ count: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
      expect(options).toMatchObject({ method: 'POST', body: JSON.stringify({ query }) });
    }
  });

  it('does not retry a GraphQL mutation', async () => {
    fetchMock.mockResolvedValueOnce(failure(503).response);
    expect(await rejection(cfGraphql(env, 'mutation { createResource { id } }'))).toMatchObject({ code: 'cloudflare_api_error' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry a GraphQL error returned with HTTP 200', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ errors: [{ message: 'private-test-token' }] }));
    const error = await rejection(cfGraphql(env, '{ viewer { accounts { id } } }'));
    expect(error).toMatchObject({ code: 'cloudflare_analytics_error' });
    expect(error.message).not.toContain(env.CF_API_TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('Cloudflare caller cancellation', () => {
  it('does not fetch when the caller has already aborted', async () => {
    const signal = AbortSignal.abort('caller deadline');
    expect(await rejection(cfApi(env, '/logs', { signal }))).toMatchObject({ code: 'cloudflare_connection_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels the backoff immediately without another request', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(failure(503).response);
    const pending = cfApi(env, '/logs', { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort('caller deadline');
    expect(await pending).toMatchObject({ code: 'cloudflare_connection_error' });
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the caller deadline to an in-flight fetch', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const pending = cfApi(env, '/logs', { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10000);
    controller.abort('caller deadline');
    expect(await pending).toMatchObject({ code: 'cloudflare_connection_error' });
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
