const { plugin } = require('varlock/plugin-lib');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const { SchemaError, ResolutionError, ValidationError } = plugin.ERRORS;
const instances = new Map();
const optionNames = new Set(['id', 'url', 'token', 'allowWebLogin', 'openBrowser', 'timeout']);

function platformUrl(value) {
  let url;
  try {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw Error();
    url = new URL(value);
  } catch {
    throw new SchemaError('JFrog url must be an absolute HTTPS platform URL');
  }
  if (url.protocol !== 'https:') throw new SchemaError('JFrog url must use HTTPS');
  if (url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new SchemaError('JFrog url must not contain credentials, a query, or a fragment');
  }
  return url.href.replace(/\/+$/, '') + '/';
}

function validToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  const fallback = () => process.stderr.write('JFrog: could not open a browser; open the login URL above manually.\n');
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', fallback);
    child.on('exit', (code) => { if (code) fallback(); });
    child.unref();
  } catch {
    fallback();
  }
}

async function webLogin(options) {
  const session = randomUUID();
  const api = `${options.url}access/api/v2/authentication/jfrog_client_login/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout * 1000);

  async function request(path, method = 'GET', body) {
    try {
      return await fetch(api + path, {
        method,
        body,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      // Network error causes may contain session URLs or response data.
      throw new ResolutionError(`JFrog ${method === 'POST' ? 'registration' : 'token'} request failed; check connectivity, HTTPS certificates, and proxy settings`);
    }
  }

  try {
    const registration = await request('request', 'POST', JSON.stringify({ session }));
    await registration.body?.cancel();
    if (registration.status !== 200) {
      throw new ResolutionError(`JFrog registration failed (HTTP ${registration.status}); browser login requires Artifactory 7.64.0 or later`);
    }

    const loginUrl = new URL('ui/login', options.url);
    loginUrl.search = new URLSearchParams({ jfClientSession: session, jfClientName: 'Varlock', jfClientCode: '1' }).toString();
    process.stderr.write(`JFrog: open this URL to sign in:\n${loginUrl.href}\nVerification code (if prompted): ${session.slice(-4)}\n`);
    if (options.openBrowser) openBrowser(loginUrl.href);

    while (true) {
      const response = await request(`token/${session}`);
      if (response.status === 200) {
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ResolutionError('JFrog token response was not valid JSON; start a new login');
        }
        if (!validToken(body?.access_token)) {
          throw new ResolutionError('JFrog token response did not contain a valid access_token; start a new login');
        }
        return body.access_token;
      }
      await response.body?.cancel();
      // JFrog's client treats HTTP 400 as pending, not as a failed login.
      if (response.status !== 400) {
        throw new ResolutionError(`JFrog token retrieval failed (HTTP ${response.status}); start a new login`);
      }
      await delay(3000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ResolutionError(`JFrog web login timed out after ${options.timeout} seconds; run Varlock again to start a new login`);
    }
    if (error instanceof ResolutionError) throw error;
    throw new ResolutionError('JFrog web login failed; start a new login');
  } finally {
    clearTimeout(timer);
  }
}

plugin.name = 'jfrog';
plugin.icon = 'simple-icons:jfrog';

plugin.registerRootDecorator({
  name: 'initJfrog',
  description: 'Configure a JFrog token or browser login',
  isFunction: true,
  useFnArgsResolver: true,
  process(args) {
    if (args.arrArgs?.length) throw new SchemaError('initJfrog expects named options');
    const options = args.objArgs || {};
    if (Object.keys(options).some((key) => !optionNames.has(key))) {
      throw new SchemaError('Unknown initJfrog option; use id, url, token, allowWebLogin, openBrowser, or timeout');
    }
    const id = options.id?.staticValue ?? '_default';
    if (options.id && (!options.id.isStatic || typeof id !== 'string' || !id.trim())) {
      throw new SchemaError('JFrog id must be a non-empty static string');
    }
    if (instances.has(id)) throw new SchemaError('JFrog instance id already initialized');
    const instance = {};
    instances.set(id, instance);
    return { instance, options };
  },
  async execute({ instance, options }) {
    const values = Object.fromEntries(await Promise.all(
      Object.entries(options).map(async ([key, resolver]) => [key, await resolver.resolve()]),
    ));
    const { token, url, allowWebLogin = false, openBrowser = true, timeout = 300 } = values;
    if (token !== undefined && token !== '' && !validToken(token)) {
      throw new SchemaError('JFrog token must be a printable ASCII string without whitespace');
    }
    if (typeof allowWebLogin !== 'boolean' || typeof openBrowser !== 'boolean') {
      throw new SchemaError('JFrog allowWebLogin and openBrowser must be boolean values');
    }
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
      throw new SchemaError('JFrog timeout must be an integer from 1 to 3600 seconds');
    }
    instance.options = {
      token, url: url === undefined || url === '' ? undefined : platformUrl(url),
      allowWebLogin, openBrowser, timeout,
    };
  },
});

plugin.registerDataType({
  name: 'jfrogAccessToken',
  sensitive: true,
  typeDescription: 'JFrog access token (JWT or reference token)',
  validate(value) {
    if (!validToken(value)) throw new ValidationError('Expected a printable ASCII JFrog access token without whitespace');
  },
});

plugin.registerResolverFunction({
  name: 'jfrogToken',
  label: 'Get a JFrog access token',
  inferredType: 'jfrogAccessToken',
  impliesSensitive: true,
  argsSchema: { type: 'array', arrayMinLength: 0, arrayMaxLength: 1 },
  process() {
    const arg = this.arrArgs?.[0];
    if (arg && (!arg.isStatic || typeof arg.staticValue !== 'string' || !arg.staticValue.trim())) {
      throw new SchemaError('jfrogToken expects a static instance id');
    }
    const instance = instances.get(arg?.staticValue ?? '_default');
    if (!instance) throw new SchemaError('Initialize this instance using @initJfrog before calling jfrogToken');
    return instance;
  },
  async resolve(instance) {
    const options = instance.options;
    if (!options) throw new ResolutionError('JFrog initialization failed; check initJfrog options');
    if (options.token) return options.token;
    if (!options.allowWebLogin) {
      throw new ResolutionError('Provide a JFrog token or set allowWebLogin=true in @initJfrog');
    }
    if (process.env.CI && !/^(false|0)$/i.test(process.env.CI)) {
      throw new ResolutionError('JFrog browser login is disabled in CI; supply token=$JFROG_TOKEN');
    }
    if (!options.url) throw new ResolutionError('JFrog browser login requires url in @initJfrog');
    // Share only in-flight login: no stale token reuse or credentials written to disk.
    instance.login ||= webLogin(options).finally(() => { instance.login = undefined; });
    return instance.login;
  },
});
