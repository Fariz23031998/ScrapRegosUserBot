import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRegosPersonalDevice } from '../src/sync/regos-auth';

const PROMPT = 'Да, это моё устройство';

function fakeLocator(clicked: string[], label: string, pattern: RegExp, present: boolean) {
  const matches = present && pattern.test(PROMPT);
  return {
    async count() {
      return matches ? 1 : 0;
    },
    first() {
      return {
        async click() {
          clicked.push(label);
        },
      };
    },
  };
}

function fakePage(present: { button?: boolean; text?: boolean }) {
  const clicked: string[] = [];
  return {
    clicked,
    getByRole(_role: string, query: { name: RegExp }) {
      return fakeLocator(clicked, 'button', query.name, Boolean(present.button));
    },
    getByText(pattern: RegExp) {
      return fakeLocator(clicked, 'text', pattern, Boolean(present.text));
    },
  };
}

describe('Regos personal-device prompt', () => {
  it('clicks “Да, это моё устройство”', async () => {
    const page = fakePage({ button: true });
    assert.equal(await acceptRegosPersonalDevice(page), true);
    assert.deepEqual(page.clicked, ['button']);
  });

  it('clicks the prompt text when it is not exposed as a button', async () => {
    const page = fakePage({ text: true });
    assert.equal(await acceptRegosPersonalDevice(page), true);
    assert.deepEqual(page.clicked, ['text']);
  });

  it('does nothing when the prompt is absent', async () => {
    const page = fakePage({});
    assert.equal(await acceptRegosPersonalDevice(page), false);
    assert.deepEqual(page.clicked, []);
  });
});
