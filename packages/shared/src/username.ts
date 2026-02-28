const adjectives = [
  'brave', 'clever', 'swift', 'golden', 'mighty', 'cosmic', 'sneaky', 'jolly',
  'bold', 'fierce', 'gentle', 'happy', 'keen', 'lucky', 'noble', 'proud',
  'quick', 'rapid', 'silent', 'tough', 'vivid', 'warm', 'witty', 'zesty',
  'bright', 'calm', 'daring', 'eager', 'fancy', 'grand', 'humble', 'icy',
  'jazzy', 'kind', 'lively', 'merry', 'neat', 'odd', 'peppy', 'quirky',
  'royal', 'shiny', 'tiny', 'unique', 'vast', 'wild', 'young', 'zealous',
  'agile', 'crisp',
] as const;

const nouns = [
  'fox', 'bear', 'hawk', 'wolf', 'seal', 'tiger', 'panda', 'otter',
  'eagle', 'shark', 'raven', 'cobra', 'moose', 'crane', 'bison', 'lemur',
  'lynx', 'viper', 'whale', 'heron', 'finch', 'gecko', 'squid', 'llama',
  'stork', 'trout', 'dove', 'mink', 'ibis', 'newt',
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateUsername(): string {
  const adj1 = pick(adjectives);
  const adj2 = pick(adjectives);
  const noun = pick(nouns);
  return `${adj1}-${adj2}-${noun}`;
}
