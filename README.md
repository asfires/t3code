# T3 Code (asfires fork)

This is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), the
open source "agent harness control surface" from the T3 team. It tracks
upstream closely and layers on changes I wanted for my own daily use.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build,
OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code
can control them.

## What is different

Everything upstream ships, plus:

- **Retract a sent message with `Escape`.** From the moment you send until the
  agent produces visible output, `Escape` pulls the message back into the
  composer, stops the agent, and rolls the provider session back so the
  retracted turn is truly gone from the model's context. Works for Claude and
  Codex.
- **Pasted-text chips.** Large pastes fold into an editable, numbered chip
  instead of filling the composer, and survive retraction and draft recovery.
- **New thread defaults.** Pick the model every new thread starts with, and set
  per-provider defaults for reasoning effort, context window, speed, and
  permission mode under Settings.
- **Claude extras.** Fable 5.1 model support, follow-up prompt suggestions after
  a turn (press Tab to accept), and Codex runs that Claude launches in the
  background show up in the Agents view.
- **Fonts and typography.** Pick from the host machine's installed fonts, and
  size the interface, prompt, code, tool output, and terminal separately.
- **Worktree branches are project-scoped.** New worktree threads use the
  project's directory name as their branch namespace.
- **Terminals activate Python virtual environments** (`.venv` or `venv`)
  automatically.
- **Server extras.** `T3CODE_SESSION_TTL` controls how long new browser
  sessions last, and projections can be rebuilt from event history.
- **Smaller fixes** across sidebar status, minimap scrolling, theme import,
  reconnect-after-restart, and Claude session resume.

The user docs under [docs/user](./docs/user) describe each of these in the
relevant feature section. The full change list is
[`git log upstream/main..main`](https://github.com/pingdotgg/t3code/compare/main...asfires:t3code:main).

## Running this fork

> [!WARNING]
> Install and authenticate at least one provider first. See
> [Providers](./docs/user/install.md#providers).

On Linux (x64) or an Apple Silicon Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/asfires/t3code/main/scripts/install.sh | sh
```

This downloads the fork's newest self-contained build from
[this repository's releases](https://github.com/asfires/t3code/releases) and
puts `t3` in `~/.local/bin`. It needs no Node, no package manager, and no
compiler. If your shell reports `command not found` afterwards, that directory
is not on your `PATH` yet; the installer prints the line to add.

| Task                                             | Command              |
| ------------------------------------------------ | -------------------- |
| Start the server and open the web app            | `t3`                 |
| Start the server without a browser               | `t3 serve`           |
| Keep it running in the background (macOS, Linux) | `t3 service install` |
| Move to the newest fork build                    | `t3 update`          |
| Remove it again                                  | `t3 uninstall`       |

An installed fork build follows the fork: `t3 update`, the background service,
and the in-app **Update server** action all fetch builds from this repository,
never upstream's.

Do **not** use `https://t3.codes/install.sh`, `npx t3`, Homebrew, winget, or the
AUR packages if you want this fork. Those install upstream. Windows and Intel
Macs have no fork build; run [from source](#from-source) there.

### Your data

The fork uses the same data directory as upstream (`~/.t3/userdata`), so an
existing T3 Code install carries straight over. The fork adds its own database
migrations in a separate ledger. Moving from the fork back to upstream on the
same data directory is not something I test, so copy `~/.t3/userdata` somewhere
safe first, or run the fork against its own directory with `T3CODE_HOME`.

### From source

Install [Vite+](https://viteplus.dev/guide/) (`vp`), which supplies the pinned
Node and pnpm versions, then:

```bash
git clone https://github.com/asfires/t3code.git
cd t3code
vp install --frozen-lockfile
vp run --filter @t3tools/web build
vp run --filter t3 build:bundle
T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false node apps/server/dist/bin.mjs
```

The environment variable stops the checkout directory itself from being added
as a project. To update, `git pull` and repeat the install and build steps. A
source checkout cannot use `t3 update` or `t3 service install`.

## Clients

**Web** is the surface I use and test. Open the web app your server serves. In
Chrome, Edge, or Safari you can install it as an app to get its own window and
Dock icon. [app.t3.codes](https://app.t3.codes) is upstream's build: it will not
have the fork's UI changes and is not tested against a fork server.

**Desktop** has no fork build. The desktop app wraps the same web app and
bundles the same server, so one built from this checkout would include
everything above, but I do not build, sign, or test it. Without an Apple
Developer ID the macOS app is unsigned, so macOS blocks it on first launch and
it cannot update itself. To build one anyway, follow
[Desktop artifacts](./docs/operations/development.md#desktop-artifacts). The
desktop apps from upstream's releases, Homebrew, winget, and the AUR are
upstream builds.

**Mobile** apps on the App Store and Google Play are upstream builds. They
connect to any T3 Code server, but I have not tested them against a fork server,
and fork-only features are not in them.

## Remote access

Direct network access with `--host` and Tailscale with `--tailscale-serve` work
as described in [Remote access](./docs/user/remote-access.md). T3 Connect does
not: it depends on hosted service configuration that only upstream's official
builds carry.

## Documentation

Full docs live in [docs/](./docs). Fork changes are documented in place.

- [Install and first run](./docs/user/install.md) (describes upstream's installers; use
  [Running this fork](#running-this-fork) instead)
- [Composer, pasted text, and new thread defaults](./docs/user/composer.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Source control integrations](./docs/user/source-control.md)
- [Terminals](./docs/user/terminals.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)

Building on the code? Start at [docs/internals/overview.md](./docs/internals/overview.md)
and [AGENTS.md](./AGENTS.md), which includes the fork-local workflow.

## Issues and contributions

Bugs in fork-only behavior belong in
[this repository's issues](https://github.com/asfires/t3code/issues). Bugs you
can reproduce on upstream belong with
[upstream](https://github.com/pingdotgg/t3code/issues); please do not report
fork problems to the T3 Discord.

Pull requests here target this fork's `main` only. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) for the upstream conventions, which this
fork follows.

## License

MIT, same as upstream.
