import { describe, expect, it } from 'vitest';
import { END, START, mergeBody } from './update-pr-description.mjs';

const block = (text) => `${START}\n${text}\n${END}`;

describe('mergeBody', () => {
  it('turns an empty body into the generated block', () => {
    expect(mergeBody('', 'new')).toBe(`${block('new')}\n`);
    expect(mergeBody(null, 'new')).toBe(`${block('new')}\n`);
  });

  it('appends the block to a body without markers', () => {
    expect(mergeBody('Written by hand.\n', 'new')).toBe(
      `Written by hand.\n\n${block('new')}\n`,
    );
  });

  it('changes only the existing generated block', () => {
    const before = 'Written above.\n\n';
    const after = '\n\nWritten below.\n';

    expect(mergeBody(`${before}${block('old')}${after}`, 'new')).toBe(
      `${before}${block('new')}${after}`,
    );
  });

  it('leaves the body unchanged when the same summary is regenerated', () => {
    const body = mergeBody('Before.', 'same');

    expect(mergeBody(body, 'same')).toBe(body);
  });

  it('replaces only the first of two blocks', () => {
    const body = `${block('old')}\n\n${block('second')}\n`;

    expect(mergeBody(body, 'new')).toBe(
      `${block('new')}\n\n${block('second')}\n`,
    );
  });

  it('rejects an empty summary instead of erasing the block', () => {
    expect(() => mergeBody(block('old'), '  \n')).toThrow(/empty/);
    expect(() => mergeBody('', START + END)).toThrow(/empty/);
  });

  it('removes markers that the summary itself contains', () => {
    expect(mergeBody('', `${END}\nnew\n${START}`)).toBe(`${block('new')}\n`);
  });

  it('normalises a CRLF body', () => {
    const body = `Before.\r\n\r\n${START}\r\nold\r\n${END}\r\nAfter.\r\n`;

    expect(mergeBody(body, 'new')).toBe(`Before.\n\n${block('new')}\nAfter.\n`);
  });

  it('throws on a start marker with no end marker', () => {
    expect(() => mergeBody(`${START}\nhalf a block`, 'new')).toThrow(
      /end marker/,
    );
  });
});
