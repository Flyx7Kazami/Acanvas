#!/usr/bin/env python3
"""Observe/exercise an explicitly supplied existing scratch app-server Unix socket.

Never starts a server, resumes a thread, changes policies, or answers approvals.
--exercise sends no-tool prompts to that already-loaded thread. Those scenarios
were NOT executed in this report because the original owner had exited.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import os
import pathlib
import struct
import time


class Rpc:
    def __init__(self, reader, writer, thread, output):
        self.reader, self.writer = reader, writer
        self.thread, self.output = thread, output
        self.records, self.waiters, self.counter = [], {}, 0
        self.completed = asyncio.Queue()
        self.server_requests = asyncio.Queue()

    def emit(self, kind, **data):
        record = {"time": round(time.time(), 3), "kind": kind, **data}
        self.records.append(record)
        print(json.dumps(record), flush=True)
        self.output.write_text(json.dumps(self.records, indent=2) + "\n")

    async def send(self, data, opcode=1):
        mask = os.urandom(4)
        n = len(data)
        size = bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack(">H", n) if n < 65536 else bytes([0xFF]) + struct.pack(">Q", n)
        self.writer.write(bytes([0x80 | opcode]) + size + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        await self.writer.drain()

    async def read(self):
        while True:
            try:
                header = await self.reader.readexactly(2)
                opcode, n = header[0] & 15, header[1] & 127
                if n == 126:
                    n = struct.unpack(">H", await self.reader.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", await self.reader.readexactly(8))[0]
                mask = await self.reader.readexactly(4) if header[1] & 128 else None
                payload = await self.reader.readexactly(n)
                if mask:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                if opcode == 8:
                    return
                if opcode == 9:
                    await self.send(payload, 10)
                    continue
                if opcode not in (1, 2):
                    continue
                message = json.loads(payload)
                if "id" in message and ("result" in message or "error" in message):
                    waiter = self.waiters.pop(message["id"], None)
                    if waiter and not waiter.done():
                        waiter.set_result(message)
                elif "id" in message:
                    self.emit("approval_or_server_request_unanswered", method=message.get("method"), id=message.get("id"), params=message.get("params"))
                    await self.server_requests.put(message)
                else:
                    params = message.get("params") or {}
                    if params.get("threadId") != self.thread:
                        continue
                    method = message.get("method")
                    if method in ("turn/started", "turn/completed"):
                        turn = params.get("turn", {})
                        self.emit("notification", method=method, turn={k: turn.get(k) for k in ("id", "status", "error")})
                        if method == "turn/completed":
                            await self.completed.put(turn)
                    elif method == "item/completed":
                        item = params.get("item", {})
                        if item.get("type") in ("agentMessage", "userMessage", "commandExecution"):
                            self.emit("notification", method=method, item={k: item[k] for k in ("id", "type", "text", "content", "command", "cwd", "status", "exitCode", "aggregatedOutput") if k in item})
            except asyncio.IncompleteReadError:
                return

    async def request(self, method, params):
        self.counter += 1
        waiter = asyncio.get_running_loop().create_future()
        self.waiters[self.counter] = waiter
        self.emit("request", id=self.counter, method=method, params=params)
        await self.send(json.dumps({"id": self.counter, "method": method, "params": params}).encode())
        response = await asyncio.wait_for(waiter, 20)
        safe = json.loads(json.dumps(response))
        if isinstance(safe.get("result"), dict):
            safe["result"].pop("codexHome", None)
        self.emit("response", method=method, response=safe)
        return response


async def main(args):
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(args.socket), 3)
    key = base64.b64encode(os.urandom(16)).decode()
    writer.write(("GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    await writer.drain()
    header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 3)
    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    assert header.startswith(b"HTTP/1.1 101") and accept in header
    rpc = Rpc(reader, writer, args.thread, pathlib.Path(args.output))
    reader_task = asyncio.create_task(rpc.read())
    try:
        await rpc.request("initialize", {"clientInfo": {"name": "acanvas_existing_scratch_probe", "version": "0.1"}})
        await rpc.send(b'{"method":"initialized","params":{}}')
        loaded = await rpc.request("thread/loaded/list", {})
        if args.thread not in loaded.get("result", {}).get("data", []):
            rpc.emit("blocked", reason="Explicit scratch thread is not already loaded; no resume attempted")
            return
        rpc.emit("existing_thread_verified", threadId=args.thread)
        if not args.exercise:
            return
        text = lambda value: [{"type": "text", "text": value}]
        started = await rpc.request("turn/start", {"threadId": args.thread, "clientUserMessageId": "acanvas-bounded-busy-1", "input": text("Isolated no-tool experiment. Think through counting to 5000 before answering ACANVAS_BUSY_BASE. Do not use tools or read files. Apply any subsequent steer text before answering.")})
        turn = started.get("result", {}).get("turn", {}).get("id")
        if not turn:
            return
        await rpc.request("turn/steer", {"threadId": args.thread, "expectedTurnId": "deliberately-stale-turn-id", "input": text("ACANVAS_STALE_MUST_REJECT")})
        steer = {"threadId": args.thread, "expectedTurnId": turn, "clientUserMessageId": "acanvas-bounded-steer-1", "input": text("Reply exactly ACANVAS_BUSY_STEER_OK. Do not use tools.")}
        await rpc.request("turn/steer", steer)
        await rpc.request("turn/steer", steer)
        await asyncio.wait_for(rpc.completed.get(), 35)
        repeat = {"threadId": args.thread, "clientUserMessageId": "acanvas-bounded-idle-retry-1", "input": text("Reply exactly ACANVAS_RETRY_OK. Do not use tools or read files.")}
        await rpc.request("turn/start", repeat)
        await asyncio.wait_for(rpc.completed.get(), 35)
        await rpc.request("turn/start", repeat)
        # Preserve observed RPCs/items; no assumption that clientUserMessageId deduplicates.
        try:
            await asyncio.wait_for(rpc.completed.get(), 15)
        except asyncio.TimeoutError:
            rpc.emit("no_second_completion_observed_within_seconds", seconds=15)
    finally:
        await rpc.send(b"", 8)
        writer.close()
        await writer.wait_closed()
        reader_task.cancel()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--thread", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--exercise", action="store_true")
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments))
    except Exception as error:
        pathlib.Path(arguments.output).write_text(json.dumps({"kind": "blocked", "errorType": type(error).__name__, "message": str(error)}, indent=2) + "\n")
        raise
