# Agent tools

`led.mjs` defines `get_led_state` and `set_led` with the Agents SDK and Zod.

Tools dispatch through `../transport/` to the ESP32, which executes the hardware
operation. `set_led` waits for a matching acknowledgement ID and checks the
reported settings. Null parameters read and preserve the board's current setting.
Each execution emits arguments and a structured result to the requesting chat.
No acknowledgement within five seconds yields an unconfirmed failure. Commands
are not automatically retried. Stopping a run cannot undo a command already sent.
