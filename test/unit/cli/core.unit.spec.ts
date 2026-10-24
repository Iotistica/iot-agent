describe('CLI API authentication', () => {
  const originalFetch = global.fetch;
  const originalUsername = process.env.IOTCTL_USERNAME;
  const originalPassword = process.env.IOTCTL_PASSWORD;

  beforeEach(() => {
    jest.resetModules();
    process.env.IOTCTL_USERNAME = 'admin';
    process.env.IOTCTL_PASSWORD = 'secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUsername === undefined) delete process.env.IOTCTL_USERNAME;
    else process.env.IOTCTL_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.IOTCTL_PASSWORD;
    else process.env.IOTCTL_PASSWORD = originalPassword;
  });

  it('logs in and retries a session-protected API request with the session cookie', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('{"error":"Not authenticated"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"username":"admin"}', {
        status: 200,
        headers: { 'set-cookie': 'admin_session=session-token; HttpOnly; Path=/' },
      }))
      .mockResolvedValueOnce(new Response('{"apps":[]}', { status: 200 }));
    global.fetch = fetchMock;

    const { apiRequest } = require('../../../cli/src/core');
    const result = await apiRequest('http://localhost:48484/v1/apps');

    expect(result).toEqual({ apps: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:48484/v1/auth/login');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      username: 'admin',
      password: 'secret',
    });
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Cookie')).toBe('admin_session=session-token');
  });

  it('keeps the original unauthenticated response when credentials are not configured', async () => {
    delete process.env.IOTCTL_USERNAME;
    delete process.env.IOTCTL_PASSWORD;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('{"error":"Not authenticated"}', { status: 401 }));
    global.fetch = fetchMock;

    const { apiRequest } = require('../../../cli/src/core');

    await expect(apiRequest('http://localhost:48484/v1/apps'))
      .rejects.toThrow('HTTP 401: {"error":"Not authenticated"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
