#include "../esp32-led/tap-capture.h"
#include <assert.h>
#include <stdio.h>

int main() {
  TapCapture taps;
  assert(!taps.rising(true, 0));
  assert(!taps.rising(false, 5)); // Contact bounce must not count.
  assert(!taps.rising(true, 10));
  assert(!taps.rising(true, 29));
  assert(taps.rising(true, 30));
  assert(taps.accept(30, true));
  assert(taps.count == 1 && taps.lit(30) && taps.lit(89));
  assert(!taps.lit(90));
  assert(!taps.rising(true, 200)); // A held contact is one tap.
  assert(!taps.rising(false, 210));
  assert(!taps.rising(false, 230));
  assert(!taps.rising(true, 300));
  assert(taps.rising(true, 320));
  assert(taps.accept(320, true) && taps.count == 2);
  assert(!taps.finish(1029));
  assert(!taps.accept(1030, true)); // Late taps never extend the window.
  assert(taps.finish(1030));
  assert(!taps.lit(1030));
  assert(!taps.accept(1100, false)); // Ignore taps while waiting for AI/offline.
  assert(taps.accept(1500, true) && taps.count == 1);
  TapCapture rollover;
  assert(rollover.accept(UINT32_MAX - 499, true));
  assert(!rollover.finish(499));
  assert(rollover.finish(500));
  assert(!rollover.lit(500));
  puts("PASS: debounce, held contact, per-tap feedback, exact deadline, busy gate, rollover");
}
