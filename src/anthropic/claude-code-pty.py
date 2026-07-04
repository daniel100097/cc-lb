#!/usr/bin/env python3
import errno
import os
import pty
import select
import sys


def main():
    command = os.environ.get("CLAUDE_CODE_LOGIN_COMMAND", "claude setup-token")
    child_pid, fd = pty.fork()

    if child_pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.execlp("sh", "sh", "-lc", f"stty cols 500 rows 40; {command}")

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    while True:
        try:
            readable, _, _ = select.select([fd, stdin_fd], [], [])
        except InterruptedError:
            continue

        if fd in readable:
            try:
                data = os.read(fd, 4096)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            os.write(stdout_fd, data)

        if stdin_fd in readable:
            data = os.read(stdin_fd, 4096)
            if data:
                os.write(fd, data)

    _, status = os.waitpid(child_pid, 0)
    if os.WIFEXITED(status):
        raise SystemExit(os.WEXITSTATUS(status))
    raise SystemExit(1)


if __name__ == "__main__":
    main()
