"""Lumen's paired Apple TV sender. JSON lines on stdin/out carry controls and events."""
import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import pyatv
from pyatv.auth.hap_pairing import parse_credentials
from pyatv.const import Protocol
from pyatv.exceptions import AuthenticationError
from pyatv.protocols.airplay.player import timing_server
from pyatv.protocols.raop.protocols import StreamContext
from pyatv.protocols.raop.protocols.airplayv2 import AirPlayV2
from pyatv.support.http import http_connect
from pyatv.support.rtsp import RtspSession


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


class VideoStream(AirPlayV2):
    """Track receiver time updates between playback events."""
    anchor_position = 0.0
    anchor_time = 0.0

    @property
    def position(self):
        elapsed = time.monotonic() - self.anchor_time if self.playback_state == "playing" else 0
        return max(0, self.anchor_position + elapsed)

    def _handle_event(self, event):
        position = event.get("params", {}).get("position") or event.get("position")
        self.anchor_position = self.position
        self.anchor_time = time.monotonic()
        if isinstance(position, dict) and position.get("timescale", 0) > 0:
            self.anchor_position = position["value"] / position["timescale"]
        super()._handle_event(event)

    async def set_playing(self, playing):
        response = await self._send_url_command({"type": "setRate", "rate": float(playing)})
        if not 200 <= response.code < 300:
            raise ValueError("The Apple TV could not change playback speed.")


async def main(host, identifier):
    os.umask(0o077)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    devices = await pyatv.scan(loop, hosts=[host], protocol=Protocol.AirPlay)
    config = next((d for d in devices if identifier.upper() in
                   {i.upper() for i in d.all_identifiers}), None)
    if config is None:
        raise ValueError("The selected Apple TV is no longer at its advertised address.")
    service = config.get_service(Protocol.AirPlay)
    directory = Path.home() / "Library/Application Support/app.lumen.player/AirPlay"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = directory / hashlib.sha256(identifier.upper().encode()).hexdigest()
    if key.exists():
        service.credentials = key.read_text().strip()
    pending = []
    if not service.credentials:
        pairing = await pyatv.pair(config, Protocol.AirPlay, loop, name="Lumen")
        try:
            await pairing.begin()
            emit("pairing")
            while line := await reader.readline():
                command = json.loads(line)
                if command["cmd"] == "pin":
                    pairing.pin(command["pin"])
                    break
                pending.append(command)
            else:
                return
            await pairing.finish()
            if not pairing.has_paired:
                raise ValueError("The Apple TV did not accept the pairing code.")
            temporary = key.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(pairing.service.credentials)
            temporary.replace(key)
            service.credentials = pairing.service.credentials
            emit("connecting")
        finally:
            await pairing.close()

    try:
        controls = await pyatv.connect(config, loop)
    except AuthenticationError:
        key.unlink(missing_ok=True)
        raise ValueError("Pairing expired. Select the Apple TV again to enter a new code.") from None
    connection = stream = playback = None
    active = False
    volume = None
    input_task = asyncio.create_task(reader.readline())

    async def send_media(load):
        nonlocal connection, stream
        connection = await http_connect(host, service.port)
        rtsp = RtspSession(connection)
        context = StreamContext()
        context.credentials = parse_credentials(service.credentials)
        stream = VideoStream(context, rtsp)
        async with timing_server(rtsp) as server:
            result = await stream.play_url(server.port, load["url"], load["start"])
            if not 200 <= result.code < 300:
                raise ValueError(f"The Apple TV refused the video ({result.code}).")
            state = stream.playback_state
            async with asyncio.timeout(45):
                while state != "playing":
                    state = await stream.wait_for_playback_state_change(state, 1)
            emit("active")
            if not load["play"]:
                await stream.set_playing(False)
            while state not in ("idle", "stopped"):
                emit("state", state=state, position=stream.position)
                state = await stream.wait_for_playback_state_change(state, 0.5)
            emit("finished")

    async def close_media():
        nonlocal playback, connection, stream
        if playback:
            playback.cancel()
            await asyncio.gather(playback, return_exceptions=True)
        if stream:
            stream.teardown()
        if connection:
            connection.close()
        playback = connection = stream = None

    try:
        while True:
            if pending:
                command = pending.pop(0)
            else:
                tasks = {input_task}
                if playback:
                    tasks.add(playback)
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                if playback in done:
                    playback.result()
                    await close_media()
                if input_task not in done:
                    continue
                line = input_task.result()
                if not line:
                    break
                command = json.loads(line)
                input_task = asyncio.create_task(reader.readline())
            action = command["cmd"]
            if action == "load":
                await close_media()
                if not active:
                    # The cast coordinator takes over and resumes once the TV confirms playback.
                    command["play"] = True
                active = True
                playback = asyncio.create_task(send_media(command))
            elif action == "seek":
                await controls.remote_control.set_position(command["at"])
            elif action in ("play", "pause") and stream and stream.playback_state:
                await stream.set_playing(action == "play")
            elif action == "volume":
                volume = command["level"] * 100
                await controls.audio.set_volume(volume)
            elif action == "mute":
                if volume is None:
                    volume = controls.audio.volume
                await controls.audio.set_volume(0 if command["muted"] else volume)
    except AuthenticationError:
        key.unlink(missing_ok=True)
        raise ValueError("Pairing expired. Select the Apple TV again to enter a new code.") from None
    finally:
        input_task.cancel()
        await close_media()
        await asyncio.gather(*controls.close(), return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main(*sys.argv[1:]))
    except Exception as error:
        emit("failed", reason=str(error) or type(error).__name__)
        sys.exit(1)
