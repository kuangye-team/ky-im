"""Verify the universal APK before allowing it into a release."""
import argparse
import hashlib
import os
import re
import struct
import subprocess
import zipfile
from pathlib import Path


def verify(apk, version, tools, expected_certificate):
    def android_tool(name, *args):
        return subprocess.check_output([str(tools / name), *args], text=True)

    badging = android_tool("aapt", "dump", "badging", str(apk))
    major, minor, patch = map(int, version.split("."))
    code = major * 1000000 + minor * 1000 + patch
    for field in [f"package: name='team.kuangye.im' versionCode='{code}' versionName='{version}'",
                  "sdkVersion:'24'", "targetSdkVersion:'37'"]:
        if field not in badging:
            raise ValueError(f"Unexpected Android manifest, expected {field}")

    with zipfile.ZipFile(apk) as archive:
        libs = [entry for entry in archive.namelist() if entry.startswith("lib/") and entry.endswith(".so")]
        abis = {entry.split("/")[1] for entry in libs}
        if abis != {"arm64-v8a", "armeabi-v7a"}:
            raise ValueError(f"Unexpected ABIs: {abis}")
        for abi in abis:
            archive.getinfo(f"lib/{abi}/libhummingbird.so")
        for entry in libs:
            with archive.open(entry) as lib:
                header = lib.read(64)
                is64 = entry.split("/")[1] == "arm64-v8a"
                if header[:6] != b"\x7fELF" + bytes([2 if is64 else 1, 1]) or struct.unpack_from("<H", header, 18)[0] != (183 if is64 else 40):
                    raise ValueError(f"Incorrect ELF architecture: {entry}")
                if is64:
                    offset, = struct.unpack_from("<Q", header, 32)
                    size, count = struct.unpack_from("<HH", header, 54)
                    lib.seek(offset)
                    for _ in range(count):
                        segment = lib.read(size)
                        if struct.unpack_from("<I", segment)[0] == 1 and struct.unpack_from("<Q", segment, 48)[0] < 16384:
                            raise ValueError(f"ELF requires 16 KB alignment: {entry}")
    android_tool("zipalign", "-c", "-P", "16", "4", str(apk))
    signature = android_tool("apksigner", "verify", "--verbose", "--print-certs", str(apk))
    fingerprints = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$", signature, re.M)
    if len(fingerprints) != 1 or (expected_certificate and fingerprints[0].lower() != expected_certificate.replace(":", "").strip().lower()):
        raise ValueError("Unexpected APK signing identity")
    print(f"team.kuangye.im {version} ({code}), minSdk 24, targetSdk 37, ARMv7 + ARM64, 16 KB aligned")
    print(f"Signing certificate SHA-256: {fingerprints[0]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("version")
    parser.add_argument("--certificate", help="expected signing certificate SHA-256")
    args = parser.parse_args()
    verify(args.apk, args.version.removeprefix("v"), Path(os.environ["ANDROID_HOME"]) / "build-tools/36.0.0", args.certificate)
    digest = hashlib.sha256()
    with args.apk.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    args.apk.with_suffix(".apk.sha256").write_text(f"{digest.hexdigest()}  {args.apk.name}\n")
