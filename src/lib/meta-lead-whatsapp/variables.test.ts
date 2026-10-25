// Meta Lead Ads → WhatsApp auto-send — variable slots, field
// catalog, mapping validation, resolution, send params, preview.
// All pure (no I/O); drains are covered in queue.test.ts.

import { describe, expect, it } from 'vitest';

import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';

import {
  buildAvailableVariableFields,
  buildVariableSendParams,
  getTemplateVariableSlots,
  renderVariablePreview,
  resolveVariableValues,
  templateMediaBlockers,
  validateVariableMappings,
} from './variables';

const BODY_ONLY = {
  header_type: undefined,
  header_content: undefined,
  body_text: 'Hello {{1}}, thanks for your enquiry!',
  buttons: [],
};

describe('getTemplateVariableSlots', () => {
  it('extracts body variables in order', () => {
    const slots = getTemplateVariableSlots({
      ...BODY_ONLY,
      body_text: 'Hi {{1}}, your {{2}} is ready.',
    });
    expect(slots).toEqual([
      { key: 'body:1', component: 'body', position: 1 },
      { key: 'body:2', component: 'body', position: 2 },
    ]);
  });

  it('maps {{1}} to Name: single body variable slot', () => {
    expect(getTemplateVariableSlots(BODY_ONLY)).toEqual([
      { key: 'body:1', component: 'body', position: 1 },
    ]);
  });

  it('extracts text-header and URL-button variables', () => {
    const slots = getTemplateVariableSlots({
      header_type: 'text',
      header_content: 'Hi {{1}}',
      body_text: 'Static body',
      buttons: [
        { type: 'URL', text: 'Track', url: 'https://x.test/t/{{1}}' },
        { type: 'QUICK_REPLY', text: 'Yes' },
      ],
    });
    expect(slots).toEqual([
      { key: 'header:1', component: 'header', position: 1 },
      {
        key: 'button:0:1',
        component: 'button',
        position: 1,
        buttonIndex: 0,
      },
    ]);
  });

  it('ignores COPY_CODE buttons (example fallback) and static buttons', () => {
    const slots = getTemplateVariableSlots({
      header_type: undefined,
      header_content: undefined,
      body_text: 'Your code is ready.',
      buttons: [
        { type: 'COPY_CODE', text: 'Copy', example: 'ABC123' },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' },
      ],
    });
    expect(slots).toEqual([]);
  });

  it('static templates have no slots', () => {
    expect(
      getTemplateVariableSlots({
        header_type: undefined,
        header_content: undefined,
        body_text: 'Thanks!',
        buttons: [],
      })
    ).toEqual([]);
  });
});

describe('templateMediaBlockers', () => {
  it('blocks media headers without a stored file only', () => {
    expect(
      templateMediaBlockers({ header_type: 'image' } as never)
    ).toHaveLength(1);
    expect(
      templateMediaBlockers({
        header_type: 'image',
        header_media_url: 'https://x.test/i.jpg',
      })
    ).toEqual([]);
    expect(templateMediaBlockers({ header_type: 'text' })).toEqual([]);
  });
});

describe('buildAvailableVariableFields', () => {
  it('exposes standard fields plus one answer field per question', () => {
    const fields = buildAvailableVariableFields([
      { key: 'full_name', label: 'Full name' },
      { key: 'city', label: 'City' },
    ]);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('name');
    expect(keys).toContain('phone');
    expect(keys).toContain('answer:full_name');
    expect(keys).toContain('answer:city');
    expect(fields.find((f) => f.key === 'answer:city')?.label).toBe('City');
  });

  it('falls back to key-derived labels and dedupes', () => {
    const fields = buildAvailableVariableFields([
      { key: null, label: null },
      { key: 'name', label: 'Custom name?' },
    ]);
    // `answer:name` is namespaced away from the standard `name`.
    expect(fields.map((f) => f.key)).toContain('answer:name');
  });
});

describe('validateVariableMappings', () => {
  const slots = getTemplateVariableSlots(BODY_ONLY);
  const keys = new Set(['name', 'phone', 'answer:city']);

  it('accepts a complete mapping and empty mappings for static templates', () => {
    expect(validateVariableMappings(slots, { 'body:1': 'name' }, keys)).toBeNull();
    expect(validateVariableMappings([], {}, keys)).toBeNull();
  });

  it('rejects missing slots, unknown fields, and unknown slot keys', () => {
    expect(validateVariableMappings(slots, {}, keys)).toContain('{{1}}');
    expect(
      validateVariableMappings(slots, { 'body:1': 'answer:nope' }, keys)
    ).toContain('unknown field');
    expect(
      validateVariableMappings(slots, { 'body:1': 'name', 'bogus': 'phone' }, keys)
    ).toContain('Unknown variable');
  });
});

describe('resolveVariableValues', () => {
  const slots = getTemplateVariableSlots({
    ...BODY_ONLY,
    body_text: 'Hi {{1}} from {{2}}.',
  });

  it('resolves and trims values from the lead field map', () => {
    const { values, missing } = resolveVariableValues(
      slots,
      { 'body:1': 'name', 'body:2': 'answer:city' },
      { name: '  Asha  ', 'answer:city': 'Goa' }
    );
    expect(missing).toEqual([]);
    expect(values).toEqual({ 'body:1': 'Asha', 'body:2': 'Goa' });
  });

  it('reports missing and empty values without placeholders', () => {
    const { values, missing } = resolveVariableValues(
      slots,
      { 'body:1': 'name', 'body:2': 'answer:city' },
      { name: '', 'answer:city': '   ' }
    );
    expect(values).toEqual({});
    expect(missing).toHaveLength(2);
    // Never leak a placeholder as a value.
    for (const v of Object.values(values)) {
      expect(v).not.toContain('{{');
    }
  });
});

describe('buildVariableSendParams', () => {
  it('builds ordered body params from resolved values', () => {
    const slots = getTemplateVariableSlots({
      ...BODY_ONLY,
      body_text: 'Hi {{1}} from {{2}}.',
    });
    const params = buildVariableSendParams(
      { ...BODY_ONLY, body_text: 'Hi {{1}} from {{2}}.' },
      slots,
      { 'body:1': 'Asha', 'body:2': 'Goa' }
    );
    expect(params.body).toEqual(['Asha', 'Goa']);
  });

  it('builds header text and URL button params', () => {
    const template = {
      header_type: 'text' as const,
      header_content: 'Hi {{1}}',
      body_text: 'Static',
      buttons: [{ type: 'URL' as const, text: 'Track', url: 'https://x.test/{{1}}' }],
    };
    const slots = getTemplateVariableSlots(template);
    const params = buildVariableSendParams(template, slots, {
      'header:1': 'Asha',
      'button:0:1': 'LEAD42',
    });
    expect(params.headerText).toBe('Asha');
    expect(params.buttonParams).toEqual({ 0: 'LEAD42' });
    expect(params.body).toBeUndefined();
  });

  it('throws instead of emitting placeholders when a value is missing', () => {
    const slots = getTemplateVariableSlots(BODY_ONLY);
    expect(() =>
      buildVariableSendParams(BODY_ONLY, slots, {})
    ).toThrow(/no resolved value/);
  });

  it('produces the exact Meta component structure', () => {
    const template = {
      header_type: undefined,
      header_content: undefined,
      body_text: 'Hello {{1}}, thanks for your enquiry!',
      buttons: [],
    };
    const slots = getTemplateVariableSlots(template);
    const params = buildVariableSendParams(template, slots, {
      'body:1': 'Asha',
    });
    const components = buildSendComponents(
      { body_text: template.body_text, buttons: [] } as never,
      params
    );
    expect(components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
    ]);
  });

  it('produces the exact Meta URL-button component structure', () => {
    const template = {
      header_type: undefined,
      header_content: undefined,
      body_text: 'Track your request:',
      buttons: [
        { type: 'URL' as const, text: 'Track', url: 'https://x.test/t/{{1}}' },
      ],
    };
    const slots = getTemplateVariableSlots(template);
    const params = buildVariableSendParams(template, slots, {
      'button:0:1': 'LEAD42',
    });
    const components = buildSendComponents(
      {
        body_text: template.body_text,
        buttons: template.buttons,
      } as never,
      params
    );
    expect(components).toContainEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'LEAD42' }],
    });
  });
});

describe('renderVariablePreview', () => {
  it('substitutes resolved values and keeps the rest as placeholders', () => {
    expect(
      renderVariablePreview('Hello {{1}} from {{2}}!', {
        'body:1': 'Asha',
      })
    ).toBe('Hello Asha from {{2}}!');
  });
});
