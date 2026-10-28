#!/usr/bin/env python3
"""Point Navigator driver login at DriverPhone::findDriverUser. Idempotent."""
import pathlib
import sys

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/fleetbase/docker/patches/ApiDriverController.php")
text = path.read_text(encoding="utf-8")
marker = "DriverPhone::findDriverUser"
if text.count(marker) >= 3:
    print("already_patched", text.count(marker))
    raise SystemExit(0)

replacements = [
(
"""        $user = User::where(
            function ($query) use ($identity) {
                $query->where('phone', static::phone($identity));
                $query->orWhere('email', $identity);
            }
        )->whereHas('driver')->first();
""",
"""        $user = \\App\\Gogate\\DriverPhone::findDriverUser($identity);
"""
),
(
"""        $user = User::where('phone', $phone)->whereHas('driver')->whereNull('deleted_at')->first();
""",
"""        $user = \\App\\Gogate\\DriverPhone::findDriverUser($phone);
"""
),
(
"""        $user = User::whereHas('driver')->where(function ($query) use ($identity) {
            $query->where('phone', $identity);
            $query->orWhere('email', $identity);
        })->first();
""",
"""        $user = \\App\\Gogate\\DriverPhone::findDriverUser($identity);
"""
),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match, found {count}")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("patched", text.count(marker))
