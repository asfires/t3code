# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## Python virtual environments

The terminal drawer opens in the thread's checkout and uses the shell configured on the server
machine.

For Python projects, T3 Code silently activates a virtual environment named `.venv` or `venv` when
it contains `pyvenv.cfg` and an activation script. `.venv` takes precedence when both exist.
Worktree threads also use a virtual environment from the original project root when the worktree
does not contain one. In Bash and zsh, activation runs as part of shell startup and is not added to
command history.

When neither standard name exists, T3 Code activates an immediate child directory if it is the
only virtual environment found in a Python project. It does not guess when multiple non-standard
environments are present.
