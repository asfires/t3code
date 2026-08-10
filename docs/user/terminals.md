# Terminals

The terminal drawer opens in the thread's checkout and uses the shell configured on the server
machine.

For Python projects, T3 Code automatically activates a virtual environment named `.venv` or
`venv` when it contains `pyvenv.cfg`. `.venv` takes precedence when both exist. Worktree threads
also use a virtual environment from the original project root when the worktree does not contain
one.
