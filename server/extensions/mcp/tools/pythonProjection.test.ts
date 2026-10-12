import { test, expect } from 'bun:test';
import { z } from 'zod';
import fixture from './pythonProjection.fixture.json';
import { projectCard, projectRows, verified } from './results';

// Frozen independent outputs from the Python reference, not computed by these helpers.
for (const scenario of fixture.cases) {
  test(`Python output parity: ${scenario.name}`, () => {
    const args = z
      .object({ view: z.string().optional(), includeDescription: z.boolean().optional() })
      .parse(scenario.args);
    const input = z.record(z.string(), z.unknown()).parse(scenario.input);
    const actual =
      scenario.kind === 'card'
        ? projectCard(input, args.view)
        : scenario.kind === 'verified'
          ? verified(input, scenario.args)
          : projectRows(input, args, scenario.kind === 'comments');
    expect(actual).toEqual(scenario.expected);
    expect(new TextEncoder().encode(JSON.stringify(actual)).byteLength).toBe(
      new TextEncoder().encode(JSON.stringify(scenario.expected)).byteLength
    );
  });
}
