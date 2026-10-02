"""YouTube -> signed Apps Script RPC -> Drive. No account cookies are loaded.

Run from the repository root: python -m worker.main
Only yt-dlp (with its default extras) and ffmpeg/Node are runtime dependencies.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import signal
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib import error, parse, request


class JobError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def normalize_youtube_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise JobError("INVALID_URL")
    try:
        url = parse.urlsplit(value.strip())
        if url.scheme != "https" or url.username or url.password or url.port:
            raise ValueError()
        host = url.hostname
        video_id = ""
        if host == "youtu.be":
            video_id = url.path.strip("/")
        elif host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
            parts = url.path.strip("/").split("/")
            if url.path == "/watch":
                video_id = parse.parse_qs(url.query).get("v", [""])[0]
            elif len(parts) == 2 and parts[0] in {"shorts", "live", "embed"}:
                video_id = parts[1]
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError()
        return "https://www.youtube.com/watch?v=" + video_id
    except ValueError as exc:
        raise JobError("INVALID_URL") from exc


def envelope(secret: str, payload: dict) -> bytes:
    # The receiver signs the original string, not a reserialized object.
    body = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    signature = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return json.dumps({"payload": body, "signature": signature}, separators=(",", ":")).encode()


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Bridge:
    def __init__(self, url: str, secret: str, job_id: str, run_id: str):
        parsed = parse.urlsplit(url)
        if (parsed.scheme != "https" or parsed.netloc != "script.google.com"
                or not re.fullmatch(r"/macros/s/[A-Za-z0-9_-]+/exec", parsed.path)
                or parsed.query or parsed.fragment):
            raise JobError("INVALID_CALLBACK_URL")
        if len(secret) < 32 or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", job_id):
            raise JobError("MISSING_CONFIG")
        self.url, self.secret, self.job_id, self.run_id = url, secret, job_id, run_id
        self.opener = request.build_opener(NoRedirect())

    def exchange(self, body: bytes) -> dict:
        req = request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
        try:
            response = self.opener.open(req, timeout=90)
        except error.HTTPError as exc:
            if exc.code not in (302, 303):
                raise
            target = exc.headers.get("Location", "")
            parsed = parse.urlsplit(target)
            if parsed.scheme != "https" or parsed.netloc != "script.googleusercontent.com":
                raise JobError("CALLBACK_ACCESS") from exc
            # Apps Script ContentService redirects to a one-time GET URL.
            # Never forward a signed POST body to the redirect destination.
            response = self.opener.open(request.Request(target), timeout=90)
        with response:
            raw = response.read(1024 * 1024)
        try:
            result = json.loads(raw)
            if not isinstance(result, dict) or "ok" not in result:
                raise ValueError()
            return result
        except (ValueError, UnicodeError) as exc:
            raise JobError("CALLBACK_ACCESS") from exc

    def call(self, action: str, data: dict | None = None) -> dict:
        last = "CALLBACK_UNREACHABLE"
        for attempt in range(5):
            body = envelope(self.secret, {"ts": int(time.time()), "job_id": self.job_id,
                                         "run_id": self.run_id, "action": action, "data": data or {}})
            try:
                result = self.exchange(body)
                if result.get("ok") is True:
                    return result
                last = result.get("code", "CALLBACK_ERROR")
                if not result.get("retryable"):
                    raise JobError(last)
            except error.HTTPError as exc:
                if exc.code not in (408, 429, 500, 502, 503, 504):
                    raise JobError("CALLBACK_ACCESS") from exc
            except (error.URLError, TimeoutError, OSError):
                pass
            if attempt < 4:
                time.sleep(min(2 ** attempt, 8))
        raise JobError(last)


def classify_download_error(message: str) -> str:
    lower = message.lower()
    if any(x in lower for x in ("sign in", "sign-in", "not a bot", "cookies", "po token", "po_token", "age-restricted")):
        return "YOUTUBE_AUTH_REQUIRED"
    if "429" in lower or "too many requests" in lower:
        return "YOUTUBE_RATE_LIMIT"
    if any(x in lower for x in ("private video", "unavailable", "removed", "members-only", "not available in your country")):
        return "VIDEO_UNAVAILABLE"
    if "403" in lower:
        return "YOUTUBE_BLOCKED"
    if "requested format" in lower:
        return "FORMAT_UNAVAILABLE"
    if "larger than max-filesize" in lower:
        return "FILE_TOO_LARGE"
    return "DOWNLOAD_FAILED"


def run_tool(args: list[str], folder: Path, timeout: int, max_bytes: int) -> str:
    # Files instead of pipes avoid deadlocks on large metadata output. Neither
    # metadata, signed media URLs nor stderr containing titles enter Actions logs.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(args, cwd=folder, stdout=out, stderr=err, start_new_session=(os.name != "nt"))
        deadline = time.monotonic() + timeout
        try:
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    raise JobError("DOWNLOAD_TIMEOUT")
                size = sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
                # Room for source streams plus ffmpeg's output, with a hard cap.
                if size > max_bytes * 3:
                    raise JobError("FILE_TOO_LARGE")
                time.sleep(0.25)
            out.seek(0)
            err.seek(0)
            stdout = out.read(16 * 1024 * 1024).decode("utf-8", "replace")
            stderr = err.read(128 * 1024).decode("utf-8", "replace")
            if proc.returncode:
                raise JobError(classify_download_error(stderr))
            return stdout
        finally:
            if proc.poll() is None:
                if os.name != "nt":
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
                proc.wait()


def download(job: dict, folder: Path) -> tuple[Path, str, str]:
    url = normalize_youtube_url(job["url"])
    fmt = job.get("format")
    if fmt not in {"mp3", "mp4"}:
        raise JobError("INVALID_FORMAT")
    max_bytes = int(job["max_bytes"])
    max_duration = int(job["max_duration"])
    if not 1024 <= max_bytes <= 500 * 1024 * 1024 or not 1 <= max_duration <= 7200:
        raise JobError("INVALID_LIMITS")
    base = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-plugin-dirs",
            "--no-cookies", "--no-cookies-from-browser", "--no-cache-dir", "--no-playlist",
            "--no-progress", "--no-warnings", "--no-colors", "--quiet", "--js-runtimes", "node",
            "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2",
            "--abort-on-unavailable-fragments", "--concurrent-fragments", "1"]
    try:
        info = json.loads(run_tool(base + ["--dump-single-json", "--skip-download", "--", url],
                                   folder, 180, max_bytes))
    except ValueError as exc:
        raise JobError("DOWNLOAD_FAILED") from exc
    if info.get("_type", "video") != "video":
        raise JobError("INVALID_URL")
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
        raise JobError("LIVE_UNSUPPORTED")
    duration = info.get("duration")
    if not duration or duration > max_duration:
        raise JobError("DURATION_LIMIT")
    options = ["--max-filesize", str(max_bytes), "-o", "media.%(ext)s"]
    if fmt == "mp3":
        options += ["-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K"]
    else:
        options += ["-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]",
                    "--merge-output-format", "mp4"]
    run_tool(base + options + ["--", url], folder, 900, max_bytes)
    output = folder / ("media." + fmt)
    if not output.is_file() or output.stat().st_size == 0:
        raise JobError("FORMAT_UNAVAILABLE")
    if output.stat().st_size > max_bytes:
        raise JobError("FILE_TOO_LARGE")
    title = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", str(info.get("title") or "YouTube"))
    title = title.strip(" .")[:150] or "YouTube"
    return output, title + "." + fmt, "audio/mpeg" if fmt == "mp3" else "video/mp4"


def upload(bridge: Bridge, path: Path, name: str, mime: str) -> dict:
    total = path.stat().st_size
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "md5").hexdigest()  # Drive transport-integrity check.
    state = bridge.call("init", {"name": name, "mime": mime, "size": total, "md5": checksum})
    chunk_size = int(state.get("chunk_size", 1024 * 1024))
    if chunk_size < 262144 or chunk_size > 4 * 1024 * 1024 or chunk_size % 262144:
        raise JobError("PROTOCOL_ERROR")
    offset = int(state.get("offset", 0))
    stalls = 0
    with path.open("rb") as stream:
        while not state.get("done"):
            if not 0 <= offset < total:
                raise JobError("PROTOCOL_ERROR")
            stream.seek(offset)
            chunk = stream.read(chunk_size)
            state = bridge.call("chunk", {"offset": offset, "content": base64.b64encode(chunk).decode("ascii")})
            next_offset = int(state.get("offset", 0))
            if not offset <= next_offset <= min(offset + len(chunk), total):
                raise JobError("PROTOCOL_ERROR")
            stalls = stalls + 1 if next_offset == offset else 0
            if stalls > 4:
                raise JobError("UPLOAD_STALLED")
            offset = next_offset
    if offset != total:
        raise JobError("PROTOCOL_ERROR")
    return state


def main() -> int:
    bridge = None
    claimed = False
    try:
        bridge = Bridge(os.environ.get("APPS_SCRIPT_URL", ""), os.environ.get("CALLBACK_SECRET", ""),
                        os.environ.get("REQUEST_ID", ""),
                        os.environ.get("GITHUB_RUN_ID", "local") + "." + os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
        if "--fail-setup" in sys.argv:
            bridge.call("fail_setup")
            return 1
        job = bridge.call("claim")
        if job.get("done"):
            print("Request already completed.")
            return 0
        claimed = True
        with tempfile.TemporaryDirectory(prefix="draive-") as tmp:
            path, name, mime = download(job, Path(tmp))
            upload(bridge, path, name, mime)
        print("File saved to Drive. See the private request sheet for its link.")
        return 0
    except JobError as exc:
        if claimed and bridge:
            try:
                bridge.call("fail", {"code": exc.code})
            except JobError:
                print("Could not report the failure; the maintenance trigger will mark it stale.")
        print("Request failed: " + exc.code)
        return 1
    except Exception:
        if claimed and bridge:
            try:
                bridge.call("fail", {"code": "WORKER_ERROR"})
            except Exception:
                pass
        print("Request failed: WORKER_ERROR")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
