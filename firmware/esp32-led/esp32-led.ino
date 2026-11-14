#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>
#include "ca_bundle.h"
#include "tap-capture.h"

constexpr uint8_t LED_PIN = 2;
constexpr uint8_t TAP_PIN = 32;
TapCapture taps;
bool high = false, dirty = false;
uint32_t lastToggle = 0, changedAt = 0;
Preferences prefs;
bool enabled = true;
uint32_t intervalMs = 100;
String backend, deviceToken, serialLine;
volatile bool socketConnected = false;
volatile bool inputBusy = false;
volatile bool voiceActive = false;
volatile bool peripheralFault = false;
constexpr uint32_t USB_BAUD = 921600;

struct Command { bool change; bool enabled; uint32_t interval; char id[65]; };
struct Report { bool enabled; uint32_t interval; char id[65]; };
struct TapEvent { bool complete; uint8_t count; char id[40]; };
struct PeripheralFrame { char json[512]; };
QueueHandle_t commands, reports, tapEvents, peripheralFrames;

void peripheralOutput(const String &json) {
  // One write keeps machine-readable frames together across both tasks.
  String frame = "@" + json + "\n";
  Serial.write((const uint8_t *)frame.c_str(), frame.length());
}
void peripheralStatus() {
  JsonDocument json;
  json["type"] = "peripheral.status"; json["connected"] = socketConnected;
  json["baud"] = USB_BAUD; json["codec"] = "pcmu"; json["rate"] = 8000;
  String frame; serializeJson(json, frame); peripheralOutput(frame);
}

void registerTap(uint32_t now) {
  if (!taps.accept(now, socketConnected && !inputBusy && !voiceActive)) return;
  enabled = false; high = false; dirty = true; changedAt = now;
  digitalWrite(LED_PIN, HIGH);
  TapEvent event = {}; event.count = taps.count;
  xQueueSend(tapEvents, &event, 0);
  if (taps.count == 1) { Report report = {}; report.enabled = false; report.interval = intervalMs; xQueueSend(reports, &report, 0); }
  Serial.printf("Tap %u accepted; recording for one second.\n", taps.count);
}

void networkTask(void *) {
  WebSocketsClient socket;
  bool secure = backend.startsWith("https://");
  String authority = backend.substring(backend.indexOf("://") + 3);
  int slash = authority.indexOf('/');
  if (slash >= 0) authority = authority.substring(0, slash);
  int colon = authority.indexOf(':');
  String host = colon >= 0 ? authority.substring(0, colon) : authority;
  uint16_t port = colon >= 0 ? authority.substring(colon + 1).toInt() : (secure ? 443 : 80);
  String headers = "Authorization: Bearer " + deviceToken;
  socket.onEvent([&](WStype_t type, uint8_t *payload, size_t length) {
    if (type == WStype_CONNECTED) {
      socketConnected = true; Serial.println("WebSocket connected.");
      peripheralStatus();
    } else if (type == WStype_DISCONNECTED) {
      socketConnected = false; Serial.println("WebSocket disconnected; reconnecting.");
      inputBusy = false;
      voiceActive = false;
      xQueueReset(peripheralFrames); peripheralStatus();
      xQueueReset(commands); xQueueReset(reports); xQueueReset(tapEvents);
    } else if (type == WStype_TEXT) {
      JsonDocument json;
      if (deserializeJson(json, payload, length)) return;
      Command command = {};
      const char *kind = json["type"] | "";
      if (strncmp(kind, "voice.", 6) == 0) {
        if (strcmp(kind, "voice.status") == 0 && (json["state"] == "closed")) voiceActive = false;
        String frame; serializeJson(json, frame); peripheralOutput(frame); return;
      }
      if (strcmp(kind, "input.ready") == 0) { inputBusy = false; return; }
      if (strcmp(kind, "get_state") == 0) command.change = false;
      else if (strcmp(kind, "command") == 0) {
        const char *id = json["id"] | "";
        if (!json["enabled"].is<bool>() || !json["interval"].is<uint32_t>() ||
            strlen(id) == 0 || strlen(id) > 64) return;
        command.change = true; command.enabled = json["enabled"].as<bool>();
        command.interval = json["interval"].as<uint32_t>();
        if (command.interval < 50 || command.interval > 2000) return;
        strlcpy(command.id, id, sizeof(command.id));
      } else return;
      if (xQueueSend(commands, &command, 0) != pdTRUE) socket.disconnect();
    }
  });
  if (secure) socket.beginSslWithBundle(host.c_str(), port, "/api/ws?role=device", CA_BUNDLE, sizeof(CA_BUNDLE), "");
  else socket.begin(host.c_str(), port, "/api/ws?role=device", "");
  socket.setExtraHeaders(headers.c_str());
  socket.setReconnectInterval(1000);
  socket.enableHeartbeat(15000, 3000, 2);
  uint32_t lastReconnect = millis(); bool announced = false;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      announced = false; socketConnected = false; inputBusy = false;
      if (voiceActive) { voiceActive = false; peripheralStatus(); }
      xQueueReset(peripheralFrames);
      xQueueReset(tapEvents);
      if (uint32_t(millis() - lastReconnect) >= 20000) { WiFi.reconnect(); lastReconnect = millis(); }
      vTaskDelay(pdMS_TO_TICKS(100)); continue;
    }
    if (!announced) {
      Serial.print("Wi-Fi connected: "); Serial.println(WiFi.localIP());
      if (secure) configTime(0, 0, "pool.ntp.org", "time.google.com");
      announced = true;
    }
    if (!backend.length() || !deviceToken.length() || (secure && time(nullptr) < 1700000000)) {
      vTaskDelay(pdMS_TO_TICKS(100)); continue;
    }
    if (peripheralFault) { peripheralFault = false; socket.disconnect(); }
    socket.loop();
    PeripheralFrame peripheral;
    // Limit each batch so incoming audio and socket heartbeats stay responsive.
    for (int n = 0; socketConnected && n < 4 && xQueueReceive(peripheralFrames, &peripheral, 0) == pdTRUE; n++) {
      if (!socket.sendTXT(peripheral.json)) { socket.disconnect(); break; }
    }
    Report report;
    while (socketConnected && xQueueReceive(reports, &report, 0) == pdTRUE) {
      JsonDocument json;
      json["type"] = "state"; json["id"] = report.id;
      json["enabled"] = report.enabled; json["interval"] = report.interval;
      json["ip"] = WiFi.localIP().toString(); json["rssi"] = WiFi.RSSI(); json["uptime"] = millis() / 1000;
      String text; serializeJson(json, text); socket.sendTXT(text);
    }
    TapEvent tap;
    while (socketConnected && xQueueReceive(tapEvents, &tap, 0) == pdTRUE) {
      JsonDocument json;
      json["type"] = tap.complete ? "tap.input" : "tap.status";
      json["count"] = tap.count;
      if (tap.complete) json["id"] = tap.id;
      String text; serializeJson(json, text); socket.sendTXT(text);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void serialCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') { if (serialLine.length() < 1536) serialLine += c; else serialLine = ""; continue; }
    if (serialLine.startsWith("{")) {
      JsonDocument json;
      if (!deserializeJson(json, serialLine)) {
        const char *kind = json["type"] | "";
        if (strcmp(kind, "peripheral.hello") == 0) peripheralStatus();
        else if (strcmp(kind, "voice.open") == 0 || strcmp(kind, "voice.start") == 0 || strcmp(kind, "voice.audio") == 0 ||
                 strcmp(kind, "voice.commit") == 0 || strcmp(kind, "voice.cancel") == 0 || strcmp(kind, "voice.close") == 0 || strcmp(kind, "voice.played") == 0) {
          if (!socketConnected) peripheralOutput("{\"type\":\"voice.error\",\"message\":\"ESP32 backend disconnected. Wait for Wi-Fi and reconnect voice.\"}");
          else if (serialLine.length() >= sizeof(PeripheralFrame::json)) peripheralOutput("{\"type\":\"voice.error\",\"message\":\"USB frame too large.\"}");
          else {
            if (strcmp(kind, "voice.open") == 0) voiceActive = true;
            PeripheralFrame frame = {}; strlcpy(frame.json, serialLine.c_str(), sizeof(frame.json));
            if (xQueueSend(peripheralFrames, &frame, 0) != pdTRUE) {
              peripheralOutput("{\"type\":\"voice.error\",\"message\":\"USB audio queue full. Reconnect voice.\"}");
              peripheralFault = true;
            }
          }
        }
      }
    } else if (serialLine == "STATUS") {
      Serial.print("WebSocket LED; IP: "); Serial.print(WiFi.localIP());
      Serial.print("; backend: "); Serial.print(backend);
      Serial.printf("; socket: %s; LED: %s; interval: %lu ms\n", socketConnected ? "connected" : "disconnected", enabled ? "enabled" : "off", (unsigned long)intervalMs);
    } else if (serialLine == "TAP") {
      // USB diagnostic: exercise the same capture path without a jumper.
      registerTap(millis());
    } else if (serialLine.startsWith("WIFI\t")) {
      int split = serialLine.indexOf('\t', 5);
      String ssid = serialLine.substring(5, split), password = serialLine.substring(split + 1);
      if (split > 5 && ssid.length() <= 32 && password.length() >= 8 && password.length() <= 63) {
        prefs.putString("ssid", ssid); prefs.putString("password", password);
        Serial.println("Wi-Fi settings saved; restarting."); Serial.flush(); ESP.restart();
      } else Serial.println("Invalid Wi-Fi settings.");
    } else if (serialLine.startsWith("BACKEND\t")) {
      int split = serialLine.indexOf('\t', 8);
      String url = serialLine.substring(8, split), token = serialLine.substring(split + 1);
      while (url.endsWith("/")) url.remove(url.length() - 1);
      bool local = url.startsWith("http://192.168.") || url.startsWith("http://10.");
      for (int i = 16; i <= 31; i++) local |= url.startsWith("http://172." + String(i) + ".");
      if (split > 8 && (url.startsWith("https://") || local) && token.length() >= 32 && token.length() <= 128) {
        prefs.putString("backend", url); prefs.putString("deviceToken", token);
        Serial.println("Backend configuration saved; restarting."); Serial.flush(); ESP.restart();
      } else Serial.println("Invalid backend settings; use HTTPS or a private LAN IP.");
    }
    serialLine = "";
  }
}

void setup() {
  Serial.setRxBufferSize(8192); Serial.setTxBufferSize(2048);
  Serial.begin(USB_BAUD); serialLine.reserve(1536); prefs.begin("led-control", false);
  enabled = prefs.getBool("enabled", true); intervalMs = constrain(prefs.getUInt("interval", 100), 50U, 2000U);
  pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, LOW);
  pinMode(TAP_PIN, INPUT_PULLDOWN);
  backend = prefs.getString("backend", ""); deviceToken = prefs.getString("deviceToken", "");
  String ssid = prefs.getString("ssid", ""), password = prefs.getString("password", "");
  commands = xQueueCreate(16, sizeof(Command)); reports = xQueueCreate(16, sizeof(Report)); tapEvents = xQueueCreate(32, sizeof(TapEvent)); peripheralFrames = xQueueCreate(32, sizeof(PeripheralFrame));
  if (!commands || !reports || !tapEvents || !peripheralFrames) { Serial.println("Queue allocation failed."); while (true) delay(1000); }
  WiFi.persistent(false); WiFi.mode(WIFI_STA); WiFi.setHostname("esp32-led"); WiFi.setAutoReconnect(true);
  if (ssid.length()) WiFi.begin(ssid.c_str(), password.c_str());
  xTaskCreatePinnedToCore(networkTask, "websocket", 16384, nullptr, 1, nullptr, 0);
  Serial.println("ESP32 WebSocket LED controller ready.");
}

void loop() {
  uint32_t now = millis();
  if (taps.finish(now)) {
    // End feedback before submitting the input. Stay off until an AI/manual command.
    high = false; digitalWrite(LED_PIN, LOW); inputBusy = socketConnected;
    TapEvent event = {}; event.complete = true; event.count = taps.count;
    snprintf(event.id, sizeof(event.id), "tap-%08lx-%08lx", (unsigned long)esp_random(), (unsigned long)now);
    if (socketConnected) xQueueSend(tapEvents, &event, 0);
    Serial.printf("Time up: %u taps; LED off; %s.\n", taps.count, socketConnected ? "sending to AI" : "offline, input discarded");
  }
  if (taps.rising(digitalRead(TAP_PIN) == HIGH, now)) registerTap(now);
  serialCommands();
  Command command;
  while (xQueueReceive(commands, &command, 0) == pdTRUE) {
    // Tap feedback owns the LED during capture; defer hardware changes at most 1s.
    if (command.change && taps.active) { xQueueSendToFront(commands, &command, 0); break; }
    if (command.change) {
      enabled = command.enabled; intervalMs = command.interval;
      high = enabled; digitalWrite(LED_PIN, high ? HIGH : LOW); lastToggle = millis();
      dirty = true; changedAt = millis();
    }
    // Acknowledge only after the main loop has applied the GPIO settings.
    Report report = {}; report.enabled = enabled; report.interval = intervalMs;
    strlcpy(report.id, command.id, sizeof(report.id));
    xQueueSend(reports, &report, 0);
  }
  now = millis();
  if (taps.active) digitalWrite(LED_PIN, taps.lit(now) ? HIGH : LOW);
  else if (enabled && uint32_t(now - lastToggle) >= intervalMs) {
    high = !high; digitalWrite(LED_PIN, high ? HIGH : LOW); lastToggle = now;
  }
  if (dirty && uint32_t(now - changedAt) >= 2000) {
    prefs.putBool("enabled", enabled); prefs.putUInt("interval", intervalMs); dirty = false;
  }
  delay(1);
}
