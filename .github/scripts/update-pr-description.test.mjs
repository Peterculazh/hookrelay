import assert from 'node:assert/strict';
import { test } from 'node:test';
import { END, START, mergeBody } from './update-pr-description.mjs';

const block = (text) => `${START}\n${text}\n${END}`;

test('an empty description becomes the generated block', () => {
  assert.equal(mergeBody('', 'new'), `${block('new')}\n`);
  assert.equal(mergeBody(null, 'new'), `${block('new')}\n`);
});

test('a description without markers keeps its text and gains the block', () => {
  assert.equal(
    mergeBody('Written by hand.\n', 'new'),
    `Written by hand.\n\n${block('new')}\n`,
  );
});

test('an existing block is replaced and the text around it is preserved', () => {
  const body = `Before.\n\n${block('old')}\n\nAfter.\n`;
  assert.equal(
    mergeBody(body, 'new'),
    `Before.\n\n${block('new')}\n\nAfter.\n`,
  );
});

test('regenerating the same summary leaves the description unchanged', () => {
  const body = mergeBody('Before.', 'same');
  assert.equal(mergeBody(body, 'same'), body);
});

test('only the first of two blocks is replaced', () => {
  const body = `${block('old')}\n\n${block('second')}\n`;
  assert.equal(
    mergeBody(body, 'new'),
    `${block('new')}\n\n${block('second')}\n`,
  );
});

test('a start marker without an end marker is left alone', () => {
  const body = `${START}\nhalf a block`;
  assert.equal(mergeBody(body, 'new'), `${body}\n\n${block('new')}\n`);
});

test('markers inside the summary are removed', () => {
  const merged = mergeBody('', `${END}\nnew\n${START}`);
  assert.equal(merged, `${block('new')}\n`);
});

test('Windows line endings in the description are normalised', () => {
  const body = `Before.\r\n\r\n${START}\r\nold\r\n${END}\r\n`;
  assert.equal(mergeBody(body, 'new'), `Before.\n\n${block('new')}\n`);
});

test('an empty summary is rejected instead of erasing the block', () => {
  assert.throws(() => mergeBody(block('old'), '  \n'), /empty/);
  assert.throws(() => mergeBody('', START + END), /empty/);
});
