export type RuntimeMode = 'fixture';

export type Capabilities = Readonly<{
  readFixture: true;
  network: false;
  sign: false;
  submitTransaction: false;
}>;

export const FIXTURE_CAPABILITIES: Capabilities = Object.freeze({
  readFixture: true,
  network: false,
  sign: false,
  submitTransaction: false
});

export function selectMode(requested: unknown): RuntimeMode {
  if (requested === undefined || requested === 'fixture') return 'fixture';
  throw new Error('Unsupported runtime mode');
}
