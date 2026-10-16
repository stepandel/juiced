// Kept in the runtime bundle so deployments need no extra image assets.
export const PTY_HELPER = String.raw`
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios
import time

columns, rows = int(sys.argv[1]), int(sys.argv[2])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.close(3)
    try:
        os.execvp(sys.argv[3], sys.argv[3:])
    except OSError as error:
        os.write(2, ('juiced: cannot start Claude: ' + str(error) + '\r\n').encode())
        os._exit(127)

os.close(slave)
stopping = None

def kill_group(sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass

def stop(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        signal.alarm(2)
        kill_group(signal.SIGTERM)

def force_stop(*_):
    kill_group(signal.SIGKILL)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    os._exit(137)

signal.signal(signal.SIGALRM, force_stop)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGHUP, stop)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
selector.register(3, selectors.EVENT_READ)
control = b''

def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]

status = None
try:
    while status is None:
        if stopping is not None and time.monotonic() - stopping >= 1:
            kill_group(signal.SIGKILL)
        for key, _ in selector.select(0.05):
            try:
                data = os.read(key.fd, 16384)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                selector.unregister(key.fd)
                if key.fd in (0, 3):
                    stop()
                continue
            if key.fd == 3:
                control += data
                *lines, control = control.split(b'\n')
                for line in lines:
                    command = json.loads(line)
                    if command['type'] == 'resize':
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['columns'], 0, 0))
                        kill_group(signal.SIGWINCH)
                    elif command['type'] == 'signal':
                        kill_group(getattr(signal, command['signal']))
                if len(control) > 4096:
                    raise ValueError('Oversized PTY control')
            else:
                write_all(1 if key.fd == master else master, data)
        ended, value = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = value
finally:
    kill_group(signal.SIGKILL)
    if status is None:
        _, status = os.waitpid(pid, 0)
    os.set_blocking(master, False)
    while True:
        try:
            data = os.read(master, 16384)
            if not data:
                break
            write_all(1, data)
        except OSError:
            break
    os.close(master)
    selector.close()

code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;
