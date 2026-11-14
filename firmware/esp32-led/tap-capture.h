#pragma once
#include <stdint.h>

// No Arduino dependency, so timing and debounce can be tested on a desktop.
struct TapCapture {
  bool active = false;
  uint8_t count = 0;
  uint32_t started = 0, lastTap = 0;
  bool raw = false, stable = false;
  uint32_t rawChanged = 0;

  bool rising(bool level, uint32_t now) {
    if (level != raw) { raw = level; rawChanged = now; }
    if (level == stable || uint32_t(now - rawChanged) < 20) return false;
    stable = level;
    return stable;
  }
  bool accept(uint32_t now, bool allowed) {
    if (!allowed || (active && uint32_t(now - started) >= 1000)) return false;
    if (!active) { active = true; started = now; count = 0; }
    if (count >= 25) return false;
    ++count; lastTap = now; return true;
  }
  bool finish(uint32_t now) {
    if (!active || uint32_t(now - started) < 1000) return false;
    active = false; return true;
  }
  bool lit(uint32_t now) const { return active && uint32_t(now - lastTap) < 60; }
};
