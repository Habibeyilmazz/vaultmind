---
title: Weather Station
tags: [project, electronics, project/active]
created: 2026-05-01
---
# Weather Station

A solar powered sensor mast in the back yard that reports temperature, humidity, pressure and rainfall every five minutes.

## Hardware

- Microcontroller with built in Wi-Fi, deep sleep between readings
- Combined temperature, humidity and barometric pressure sensor inside a radiation shield
- Tipping bucket rain gauge, 0.2 mm per tip
- 6 V solar panel charging a single lithium cell

## Firmware

The board wakes up, takes three readings, sends the median over MQTT and goes back to sleep. Average current is about 180 µA, so the battery survives two cloudy weeks.

```c
// median of three readings smooths out sensor glitches
float median3(float a, float b, float c);
```

## Open questions

- Does the rain gauge need a heater in winter?
- Wind speed: buy an anemometer or build one?

The rainfall numbers decide when [[Garden Irrigation]] is allowed to run.
