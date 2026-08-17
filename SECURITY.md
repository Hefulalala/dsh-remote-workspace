# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.0.x   | ✅        |

Security fixes are released as patch releases on top of the latest version.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately through [GitHub's private vulnerability reporting](https://github.com/Hefulalala/dsh-remote-workspace/security/advisories/new)
or by contacting the maintainer directly. Include:

- the affected version(s)
- steps to reproduce
- impact and any suggested mitigation

You will receive an acknowledgement as soon as possible.

## Known security trade-offs (MVP)

- **Credentials at rest**: passwords and private-key passphrases are stored in
  plain text inside `$DSH_HOME/storages/remote-workspaces.json`. The file is
  created with `0600` permissions, but a process running as the same OS user
  can read it. For production use, integrate with the DSH credentials service
  or an OS keyring.
- **Private keys are not copied**: only the host path to the private key file is
  saved. Protect that key file with normal filesystem permissions.
- **Host-key verification**: trust on first use (TOFU). A changed SSH host key
  causes the connection to be rejected; re-add or edit the site to accept the
  new key after verifying it out of band.
- **Plugin code has the user's privileges**: as with any DSH plugin, installing
  this plugin runs third-party code with the same permissions as your DSH
  process. Review the source before installing it into an environment that
  contains secrets.
- **Web API surface**: the HTTP API under `/remote-workspaces/api` is same-origin
  and does not add CORS headers; do not expose the DSH web port to untrusted
  networks without additional protection.

## Best practices for users

- Prefer SSH agent or private-key authentication over password authentication.
- Keep the DSH data directory (`$DSH_HOME`) protected by OS permissions.
- Do not share your DSH profile directory or `remote-workspaces.json` file.
