import { EventEmitter } from 'events';

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

  it('gives non-interactive runs setup instructions when credentials are not configured', async () => {
    delete process.env.IOTCTL_USERNAME;
    delete process.env.IOTCTL_PASSWORD;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('{"error":"Not authenticated"}', { status: 401 }));
    global.fetch = fetchMock;

    const { apiRequest } = require('../../../cli/src/core');

    await expect(apiRequest('http://localhost:48484/v1/apps'))
      .rejects.toThrow('Set IOTCTL_USERNAME and IOTCTL_PASSWORD to authenticate with the Device API');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prompts for credentials and retries when authentication is required in a terminal', async () => {
    delete process.env.IOTCTL_USERNAME;
    delete process.env.IOTCTL_PASSWORD;

    const inputDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const outputDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
    const fakeInput = new EventEmitter() as any;
    fakeInput.isTTY = true;
    fakeInput.resume = jest.fn();
    fakeInput.pause = jest.fn();
    fakeInput.setEncoding = jest.fn();
    fakeInput.setRawMode = jest.fn((enabled: boolean) => {
      if (enabled) setImmediate(() => fakeInput.emit('data', 'test-password\r'));
      return fakeInput;
    });
    Object.defineProperty(process, 'stdin', { configurable: true, value: fakeInput });
    Object.defineProperty(process, 'stdout', {
      configurable: true,
      value: { isTTY: true, write: jest.fn() },
    });
    const readline = require('readline');
    const createInterface = jest.spyOn(readline, 'createInterface').mockReturnValue({
      question: (_prompt: string, callback: (answer: string) => void) => callback('admin'),
      close: jest.fn(),
    } as any);

    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('{"error":"Not authenticated"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"username":"admin"}', {
        status: 200,
        headers: { 'set-cookie': 'admin_session=session-token; HttpOnly; Path=/' },
      }))
      .mockResolvedValueOnce(new Response('{"apps":[]}', { status: 200 }));
    global.fetch = fetchMock;

    try {
      const { apiRequest } = require('../../../cli/src/core');
      await expect(apiRequest('http://localhost:48484/v1/apps')).resolves.toEqual({ apps: [] });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        username: 'admin',
        password: 'test-password',
      });
      expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Cookie'))
        .toBe('admin_session=session-token');
    } finally {
      createInterface.mockRestore();
      if (inputDescriptor) Object.defineProperty(process, 'stdin', inputDescriptor);
      if (outputDescriptor) Object.defineProperty(process, 'stdout', outputDescriptor);
    }
  });
});
