import { describe, it, expect } from "vitest";
import { checkTemplate, isSafeTemplate } from "./template-check.js";

describe("isSafeTemplate", () => {
  it("allows plain text and the everyday shapes", () => {
    for (const text of [
      "Good morning",
      "It is {{ states('sensor.outside_temperature') }} °C outside",
      "{{ states('sensor.outside_temperature') | float(0) | round(1) }}",
      "{{ state_attr('sensor.outside_temperature', 'unit_of_measurement') }}",
      "{{ is_state('sun.sun', 'above_horizon') }}",
      "{{ states('sensor.outside_temperature') | float > 25 }}",
      "{{ states('sensor.a') | float + states('sensor.b') | float }}",
      "{{ 'open' if is_state('cover.garage', 'open') else 'closed' }}",
      "{{ not is_state('binary_sensor.door', 'on') and states('sensor.t') | int(0) < 18 }}",
      "{{ states.sensor.outside_temperature.state }}",
      "{{ states.sensor.outside_temperature.attributes.unit_of_measurement }}",
      "{{ trigger.to_state.state }} from {{ trigger.from_state.state }}",
      "{{ state_attr(trigger.entity_id, 'friendly_name') }}",
      "{{ trigger.to_state.attributes.friendly_name }}",
      "{{ now().strftime('%H:%M') }}",
      "{{ now().hour >= 22 }}",
      "{{ as_timestamp(states('sensor.next_alarm')) | timestamp_custom('%H:%M') }}",
      "{{ today_at('07:00') }}",
      "Round {{ repeat.index }}",
      "{{- states('sensor.t') -}}",
      "{# a note #}{{ states('sensor.t') }}",
    ]) {
      expect(isSafeTemplate(text), text).toBe(true);
    }
  });

  it("reports every entity a template reads, however it is spaced", () => {
    expect(checkTemplate("{{ states . sensor . private_temperature . state }}")).toEqual({
      safe: true,
      ids: ["sensor.private_temperature"],
    });
    expect(
      checkTemplate("{{ states( 'Sensor.A' ) }} and {{ state_attr('sensor.b', 'x') }}").ids
    ).toEqual(["sensor.a", "sensor.b"]);
    expect(checkTemplate("{{ state_attr(trigger.entity_id, 'friendly_name') }}").ids).toEqual([]);
  });

  it("refuses everything outside those shapes", () => {
    for (const text of [
      "{{ states | count }}",
      "{{ states.light | list }}",
      "{{ states.light.kitchen }}",
      "{{ states('light' ~ '.kitchen') }}",
      "{{ states('light.kitchen' | lower) }}",
      "{{ is_state('light.kitchen' | replace('a', 'b'), 'on') }}",
      "{{ state_attr('light.kitchen'[:0], 'x') }}",
      "{{ states(x) }}",
      "{{ my_variable }}",
      "{{ expand('group.family') }}",
      "{{ closest('group.family') }}",
      "{{ distance('device_tracker.phone') }}",
      "{{ area_entities('kitchen') }}",
      "{{ states('sensor.t') | replace('1', '2') }}",
      "{{ states('sensor.t') | default(states('sensor.u')) }}",
      "{{ states('sensor.t').upper() }}",
      "{{ 'a'.join(['b']) }}",
      "{{ namespace(x=1) }}",
      "{{ range(10) | list }}",
      "{% for s in states %}{{ s }}{% endfor %}",
      "{% from 'x.jinja' import y %}",
      "{% set x = 1 %}",
      "{{ trigger['event'] }}",
      "{{ now().replace(year=1) }}",
      "{{ '}}' }}",
      "{{ }}",
      "{{ states('sensor.t')",
    ]) {
      expect(isSafeTemplate(text), text).toBe(false);
    }
  });
});
