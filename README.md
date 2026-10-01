# Varlock JFrog plugin

Get a JFrog access token using browser login, including your platform's SSO flow,
and inject it into commands with Varlock. Uses the same login endpoints as JFrog
CLI; no JFrog CLI, password handling, OAuth application, or runtime dependency is
needed besides Varlock.

**Status:** locally tested against Varlock 1.21.1 with simulated JFrog responses.
Live JFrog/SSO testing is still needed. Requires Node.js 22.3+ and Artifactory
7.64.0+ over HTTPS. There is no build step.

## Try with SSO

From this checkout, on a machine with access to your JFrog platform:

```sh
npm ci
npm test
export JFROG_URL=https://your-company.jfrog.io
unset JFROG_TOKEN JFROG_ACCESS_TOKEN
npx varlock run --path ./examples -- node -e 'if (!process.env.JFROG_ACCESS_TOKEN) process.exit(1); console.log("JFrog token received and injected")'
```

The plugin prints a login URL and four-character verification code to stderr,
then tries to open your browser. Complete SSO and enter the code if prompted.
The command should report `JFrog token received and injected` without printing
the token. Browser login is disabled when `CI` is set (except `false` or `0`).

To check that JFrog also accepts the token, use this instead of the last command:

```sh
npx varlock run --path ./examples -- node --input-type=module -e '
  const base = process.env.JFROG_URL.replace(/\/+$/, "") + "/";
  try {
    const response = await fetch(new URL("artifactory/api/system/version", base), {
      headers: { Authorization: "Bearer " + process.env.JFROG_ACCESS_TOKEN },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    console.log("JFrog version endpoint: HTTP " + response.status);
    await response.body?.cancel();
    if (!response.ok) process.exitCode = 1;
  } catch {
    console.error("JFrog verification request failed; check connectivity and certificates");
    process.exitCode = 1;
  }
'
```

Each invocation starts a new login unless a token is supplied. API permissions
are determined by JFrog; receiving a token does not grant additional access.

For feedback, report OS, Node and Varlock versions, Artifactory version if known,
whether the browser completed SSO, and the error stage/status code. Omit tokens,
full login URLs, verification codes, and browser/network dumps.

## Use in a project

Install a published version from npm:

```sh
npm install --save-dev varlock @zargscale/varlock-jfrog-plugin
```

Before the first registry release, or to test local changes, install from a
checkout or a tarball made with `npm pack`:

```sh
npm install --save-dev varlock /path/to/varlock-jfrog-plugin
```

Add to your project's `.env.schema`:

```dotenv
# @plugin(@zargscale/varlock-jfrog-plugin)
# @initJfrog(url=$JFROG_URL, token=$JFROG_TOKEN, allowWebLogin=forEnv(dev))
# ---

# @type=url @required
JFROG_URL=https://your-company.jfrog.io

# @type=jfrogAccessToken @sensitive @internal
JFROG_TOKEN=

# @type=jfrogAccessToken @sensitive @required
JFROG_ACCESS_TOKEN=jfrogToken()
```

Run `npx varlock run -- your-command`. Supply `JFROG_TOKEN` through your CI secret
store for noninteractive runs. A supplied token takes precedence and is passed
through without a network request; the plugin does not validate its permissions
or expiration. The resolver and data type mark the result sensitive automatically.

`forEnv(dev)` follows Varlock's environment selection. Set `allowWebLogin=true`
explicitly if you want browser login in other local environments. To load the
plugin without installing it, use `@plugin(/absolute/path/to/this/checkout)`.

## Options

`@initJfrog(...)` accepts named arguments:

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | Unset | HTTPS platform root; required for web login. Reverse-proxy path prefixes are preserved. |
| `token` | Unset | Existing access token, usually a reference to a sensitive env variable. |
| `allowWebLogin` | `false` | Allow browser login when no token is supplied. |
| `openBrowser` | `true` | Attempt to open the URL; `false` allows manual opening. |
| `timeout` | `300` | Total login timeout in seconds, integer from 1 to 3600. Individual HTTP requests have a 15-second timeout. |
| `id` | Default instance | Static name, selected with `jfrogToken(name)`. |

Use `jfrogToken()` for the default instance. Multiple named instances are
independent. Concurrent requests using one instance share the pending login.
Unused instances do not trigger login.

The plugin registers a random session with
`POST /access/api/v2/authentication/jfrog_client_login/request`, opens
`/ui/login?jfClientSession=...&jfClientName=Varlock&jfClientCode=1`, and polls
`GET /access/api/v2/authentication/jfrog_client_login/token/{session}` every three
seconds. HTTP 400 means login is pending; other non-200 responses fail immediately.
The token endpoint is a one-time exchange, so retry failures with a new login.

Tokens and refresh tokens are not persisted by the plugin; refresh tokens are
discarded. There is no token refresh or persistent cache. A long-running child
command receives a fixed token and must restart after it expires.

## Troubleshooting

- **Registration HTTP 404:** check the platform root (not `/ui` or `/artifactory`),
  server version, and reverse-proxy routing to `/access`.
- **Request failed:** the Node process must reach JFrog directly, including its
  Access API. Browser connectivity alone is not enough. For a company CA, launch
  Node with `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`. This plugin uses the
  runtime's native `fetch`; it does not configure a proxy agent itself.
- **Timeout after SSO:** check that the browser returned to JFrog, that any code
  prompt was completed, and that your proxy forwards the login query parameters.
- **Browser did not open:** open the displayed URL manually, or set
  `openBrowser=false`. Browser launchers are `open`, `xdg-open`, and
  `rundll32.exe` on macOS, Linux, and Windows respectively.
- **HTTP 401/403 during token retrieval:** check JFrog login policy and Access
  logs with your administrator. Server response bodies are deliberately excluded
  from errors because they may contain secrets.

## Development and references

Pushes and pull requests run the tests in GitHub Actions. To publish the version
in `package.json`, run **Test and publish** manually from the default branch:

```sh
gh workflow run publish.yml --repo zargscale/varlock-jfrog-plugin
```

Publishing runs only after tests pass, uses the organization's `NPM_TOKEN` Actions
secret, and includes npm provenance. The secret must allow publishing public
packages in the `@zargscale` npm scope. Increment the version in both
`package.json` and `package-lock.json` before each subsequent publish.

`npm test` exercises the actual plugin through Varlock's loader, mocking only
external effects. It checks token injection and sensitivity, session registration,
pending polling, concurrent resolution, validation, named instances, CI behavior,
timeouts, and sanitized errors. These tests cannot establish SSO compatibility.

The plugin structure follows [Varlock's 1Password plugin](https://github.com/dmno-dev/varlock/blob/4c17eee979f3fe05c1b096314d7821a4feb80a2d/packages/plugins/1password/src/plugin.ts)
and the [Varlock plugin guide](https://varlock.dev/guides/plugins/).
The protocol follows [JFrog CLI's web login](https://github.com/jfrog/jfrog-cli-core/blob/b47892ded3a09d8b64543387e880ddb71d323c59/artifactory/utils/weblogin.go)
and [JFrog's Go client's login service](https://github.com/jfrog/jfrog-client-go/blob/ab72c67e288c6af65a5032e255ad58f484a8777d/access/services/login.go).
See also [JFrog's browser-login requirements](https://docs.jfrog.com/integrations/docs/jf-login)
and [Node's additional CA certificates](https://nodejs.org/api/cli.html#node_extra_ca_certsfile).
