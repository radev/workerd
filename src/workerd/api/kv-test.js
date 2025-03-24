// Copyright (c) 2023 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from 'node:assert';
import { WorkerEntrypoint } from 'cloudflare:workers';

export default class KVTest extends WorkerEntrypoint {
  // Producer receiver (from `env.NAMESPACE`)
  async fetch(request, env, ctx) {
    let result = 'example';
    const { pathname } = new URL(request.url);
    if (pathname === '/fail-client') {
      return new Response(null, { status: 404 });
    } else if (pathname == '/fail-server') {
      return new Response(null, { status: 500 });
    } else if (pathname == '/get-json') {
      result = JSON.stringify({ example: 'values' });
    } else {
      // generic success for get key
      result = 'value-' + pathname.slice(1);
    }

    let response = new Response(result, { status: 200 });
    response.headers.set(
      'CF-KV-Metadata',
      '{"someMetadataKey":"someMetadataValue","someUnicodeMeta":"🤓"}'
    );

    return response;
  }

  async getBulk(keys, options, withMetadata) {
    if (keys.length < 1) {
      throw new Error('Missing keys');
    }
    if (keys.length > 100) {
      throw new Error('Too many keys');
    }
    if (typeof options == 'undefined' || typeof options == 'string') {
      options = { type: options };
    }
    let result = new Map();

    switch (options.type) {
      case 'json':
        for (const key of keys) {
          if (key == 'key-not-json') {
            throw new Error('key-not-json key value is not json');
          }
          const val = { example: `values-${key}` };
          if (withMetadata) {
            result.set(key, { value: val, metadata: 'example-metadata' });
          } else {
            result.set(key, val);
          }
        }
        break;
      case 'text':
      case undefined:
        for (const key of keys) {
          const val = JSON.stringify({ example: `values-${key}` });
          if (key == 'not-found') {
            result.set(key, null);
          } else if (withMetadata) {
            result.set(key, { value: val, metadata: 'example-metadata' });
          } else {
            result.set(key, val);
          }
        }
        break;
      default:
        // invalid type requested
        throw new Error('unsupported type');
    }
    return Promise.resolve(result);
  }
}

export let getTest = {
  async test(ctrl, env, ctx) {
    let response = await env.KV.get('success', {});
    assert.strictEqual(response, 'value-success');

    response = await env.KV.get('fail-client');
    assert.strictEqual(response, null);
    await assert.rejects(env.KV.get('fail-server'), {
      message: 'KV GET failed: 500 Internal Server Error',
    });

    response = await env.KV.get('get-json');
    assert.strictEqual(response, JSON.stringify({ example: 'values' }));

    response = await env.KV.get('get-json', 'json');
    assert.deepStrictEqual(response, { example: 'values' });

    response = await env.KV.get('success', 'stream');
    let result = '';
    const decoder = new TextDecoder();
    for await (const chunk of response) {
      result += decoder.decode(chunk, { stream: true });
    }
    result += decoder.decode();
    assert.strictEqual(result, 'value-success');

    response = await env.KV.get('success', 'arrayBuffer');
    assert.strictEqual(new TextDecoder().decode(response), 'value-success');
  },
};

export let getBulkTest = {
  async test(ctrl, env, ctx) {
    // // Testing .get bulk
    let response = await env.KV.get(['key1', 'key2']);
    let expected = new Map([
      ['key1', '{\"example\":\"values-key1\"}'],
      ['key2', '{\"example\":\"values-key2\"}'],
    ]);
    assert.deepStrictEqual(response, expected);

    response = await env.KV.get(['key1', 'key2'], {});
    expected = new Map([
      ['key1', '{\"example\":\"values-key1\"}'],
      ['key2', '{\"example\":\"values-key2\"}'],
    ]);
    assert.deepStrictEqual(response, expected);

    let fullKeysArray = [];
    let fullResponse = new Map();
    for (let i = 0; i < 100; i++) {
      fullKeysArray.push(`key` + i);
      fullResponse.set(`key` + i, `{\"example\":\"values-key${i}\"}`);
    }

    response = await env.KV.get(fullKeysArray, {});
    assert.deepStrictEqual(response, fullResponse);

    //sending over 100 keys
    fullKeysArray.push('key100');
    await assert.rejects(env.KV.get(fullKeysArray), {
      message: 'Too many keys',
    });

    response = await env.KV.get(['key1', 'not-found'], { cacheTtl: 100 });
    expected = new Map([
      ['key1', '{\"example\":\"values-key1\"}'],
      ['not-found', null],
    ]);
    assert.deepStrictEqual(response, expected);

    await assert.rejects(env.KV.get([]), {
      message: 'Missing keys',
    });

    // // get bulk json
    response = await env.KV.get(['key1', 'key2'], 'json');
    expected = new Map([
      ['key1', { example: 'values-key1' }],
      ['key2', { example: 'values-key2' }],
    ]);
    assert.deepStrictEqual(response, expected);

    // // get bulk json but it is not json - throws error
    await assert.rejects(env.KV.get(['key-not-json', 'key2'], 'json'), {
      message: 'key-not-json key value is not json',
    });

    // // requested type is invalid for bulk get
    await assert.rejects(env.KV.get(['key-not-json', 'key2'], 'arrayBuffer'), {
      message: 'unsupported type',
    });

    await assert.rejects(
      env.KV.get(['key-not-json', 'key2'], { type: 'banana' }),
      {
        message: 'unsupported type',
      }
    );

    // // get with metadata
    response = await env.KV.getWithMetadata('key1');
    expected = {
      value: 'value-key1',
      metadata: { someMetadataKey: 'someMetadataValue', someUnicodeMeta: '🤓' },
      cacheStatus: null,
    };
    assert.deepStrictEqual(response, expected);

    response = await env.KV.getWithMetadata(['key1']);
    expected = new Map([
      [
        'key1',
        { metadata: 'example-metadata', value: '{"example":"values-key1"}' },
      ],
    ]);
    assert.deepStrictEqual(response, expected);

    response = await env.KV.getWithMetadata(['key1'], 'json');
    expected = new Map([
      [
        'key1',
        { metadata: 'example-metadata', value: { example: 'values-key1' } },
      ],
    ]);
    assert.deepStrictEqual(response, expected);
    response = await env.KV.getWithMetadata(['key1', 'key2'], 'json');
    expected = new Map([
      [
        'key1',
        { metadata: 'example-metadata', value: { example: 'values-key1' } },
      ],
      [
        'key2',
        { metadata: 'example-metadata', value: { example: 'values-key2' } },
      ],
    ]);
    assert.deepStrictEqual(response, expected);
  },
};
