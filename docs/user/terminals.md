# Terminals

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
