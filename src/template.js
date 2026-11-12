// The form, written as data.
//
// To add, remove or reword a question, change this file only. No screen code has to change.
// After a change, run "npm test" (it checks this file for mistakes) and "npm run build".
//
// Words in curly brackets, {power} and {telecom}, are replaced by the company names the user
// sets in Settings.
//
// Each item can use:
//   type        text | number | choice | toggle | note | heading | divider | computed | gps | spanmap | photos | review
//   key         the name the answer is stored under. Never reuse or rename a key once data exists.
//   label       the words on screen
//   column      the words used as the column heading in exports (defaults to the label)
//   unit        m | ft | deg, for numbers
//   soft        [low, high]: outside this the app says "check the entry". It never blocks.
//   options     the choices, for type "choice"
//   mono        show in the fixed-width typeface (tags and codes)
//   layout      "row" puts the label and a short number box on one line
//   showIf      only show the item when the condition is true
//   naIf        show "N/A" in place of the item when the condition is true
//   expect      true: list the item under "Left blank" when empty
//   expectIf    list it under "Left blank" only when the condition is true
//   expectUnless  never list it under "Left blank" when the condition is true
//   expectUnlessSpans  true: not "Left blank" once the span diagram has a span on it
//   differsFrom { key, text }: warn when both are filled and do not match
//   uniqueInJob text: warn when another pole in the job has the same answer
//
// A condition is one of:
//   { key, is: value }      { key, not: value }      { key, in: [values] }
//   { key, filled: true }   { any: [conditions] }    [conditions]  (all must be true)

const YES_NO = ['Yes', 'No'];
const HAS_SECONDARY = { key: 'secondary', in: ['1Ø', '3Ø', 'Both'] };
const NO_SECONDARY = { key: 'secondary', is: 'None' };
const WIRE_TO_WIRE = { key: 'ww', is: true };

const ground = (key, label, soft, extra) => ({
  type: 'number', key, label, unit: 'm', layout: 'row', soft, column: 'Ground to ' + label.toLowerCase(), ...extra,
});

const wire = (key, label, soft, extra) => ({
  type: 'number', key, label, unit: 'm', layout: 'row', soft, showIf: WIRE_TO_WIRE, column: 'Measured: ' + label.toLowerCase(), ...extra,
});

const span = (n, extra) => ({
  type: 'text', key: 'span' + n, label: 'Span ' + n + ' : To pole located', placeholder: 'direction and distance', ...extra,
});

export const TEMPLATE = {
  id: 'pole-third-party',
  version: 1,
  name: 'Third party field data',

  photoLabels: ['Whole pole', 'Pole tag', 'Pole top', 'Anchor', 'Other'],

  job: {
    titleKey: 'location',
    codeKey: 'designNo',
    items: [
      { type: 'text', key: 'location', label: 'Location', expect: true },
      { type: 'text', key: 'date', label: 'Date' },
      { type: 'text', key: 'collectedBy', label: 'Collected by' },
      { type: 'text', key: 'designNo', label: 'Design # / Job', mono: true },
      { type: 'text', key: 'otherId', label: 'Other identifiers' },
    ],
  },

  pole: {
    tagKeys: ['tagField', 'tagMap'],
    steps: [
      {
        key: 'pole',
        title: 'Pole',
        items: [
          { type: 'text', key: 'tagMap', label: 'Pole tag # from map', column: 'Pole tag # (map)', mono: true, expect: true },
          {
            type: 'text', key: 'tagField', label: 'Pole tag # in field', column: 'Pole tag # (field)', mono: true,
            expect: true, expectUnless: { key: 'tagStatus', is: 'Missing' },
            differsFrom: { key: 'tagMap', text: 'Does not match the map tag' },
            uniqueInJob: 'Another pole in this job has the same tag',
          },
          { type: 'choice', key: 'tagStatus', label: 'Tag status', column: 'Pole tag status', options: ['OK', 'Damaged', 'Missing'], expect: true },
          { type: 'choice', key: 'poleType', label: 'Pole type', options: ['Wood', 'Concrete'], expect: true },
          { type: 'choice', key: 'condition', label: 'Pole condition', options: ['Good', 'Questionable', 'Bad'], expect: true },
          { type: 'text', key: 'testTreat', label: 'Pole test & treat date' },
          { type: 'number', key: 'height', label: 'Pole height', unit: 'ft', soft: [25, 120], expect: true },
          { type: 'text', key: 'poleClass', label: 'Pole class', expect: true },
          { type: 'number', key: 'angle', label: 'Angle of deflection', unit: 'deg', soft: [0, 180] },
          { type: 'gps', key: 'gps', label: 'GPS position' },
        ],
      },
      {
        key: 'equipment',
        title: 'Equipment',
        items: [
          { type: 'choice', key: 'xfmr', label: 'Transformers', options: ['None', '1Ø', '2Ø', '3Ø'], expect: true },
          { type: 'choice', key: 'secondary', label: 'Secondary on pole', options: ['None', '1Ø', '3Ø', 'Both'], expect: true },
          { type: 'choice', key: 'powerDip', label: '{power} dip', options: YES_NO, expect: true },
          { type: 'choice', key: 'streetLight', label: 'Street light', options: ['No', 'Yes', 'Yes - Bonded'], expect: true },
          { type: 'choice', key: 'telPlant', label: '{telecom} plant on pole', options: YES_NO, expect: true },
          { type: 'choice', key: 'telDip', label: '{telecom} dip off pole', options: YES_NO, expect: true },
        ],
      },
      {
        key: 'anchors',
        title: 'Anchors',
        items: [
          { type: 'choice', key: 'powerAnchor', label: '{power} anchor', options: YES_NO, expect: true },
          { type: 'text', key: 'powerSlots', label: '{power} anchor eye slots', naIf: { key: 'powerAnchor', is: 'No' }, expectIf: { key: 'powerAnchor', is: 'Yes' } },
          { type: 'text', key: 'powerPlate', label: '{power} plate & lead length', naIf: { key: 'powerAnchor', is: 'No' }, expectIf: { key: 'powerAnchor', is: 'Yes' } },
          { type: 'text', key: 'powerRod', label: '{power} anchor rod size', naIf: { key: 'powerAnchor', is: 'No' }, expectIf: { key: 'powerAnchor', is: 'Yes' } },
          { type: 'divider', key: 'dTelAnchor' },
          { type: 'choice', key: 'telAnchor', label: '{telecom} anchor', options: YES_NO, expect: true },
          { type: 'text', key: 'telSlots', label: '{telecom} anchor eye slots', naIf: { key: 'telAnchor', is: 'No' }, expectIf: { key: 'telAnchor', is: 'Yes' } },
          { type: 'divider', key: 'dJointAnchor' },
          { type: 'choice', key: 'jointAnchor', label: 'Joint anchor', options: YES_NO, expect: true },
          { type: 'text', key: 'jointSlots', label: 'Joint anchor eye slots', naIf: { key: 'jointAnchor', is: 'No' }, expectIf: { key: 'jointAnchor', is: 'Yes' } },
        ],
      },
      {
        key: 'heights',
        title: 'Heights from ground',
        items: [
          ground('gP', 'Primary bolt', [5, 22], { expect: true, expectUnless: WIRE_TO_WIRE }),
          ground('gN', 'Neutral', [4, 20], { expect: true, expectUnless: WIRE_TO_WIRE }),
          ground('gS', 'Secondary, lowest', [3.5, 18], { column: 'Ground to lowest secondary', naIf: NO_SECONDARY, expectIf: HAS_SECONDARY, expectUnless: WIRE_TO_WIRE }),
          ground('gT', '{telecom}, top cable', [3, 15], {
            column: 'Ground to {telecom} top cable', expect: true,
            expectUnless: { any: [WIRE_TO_WIRE, { key: 'telPlant', is: 'No' }] },
          }),
          { type: 'toggle', key: 'ww', label: 'I measured wire to wire instead', column: 'Measured wire to wire' },
          wire('mP', 'Neutral to primary bolt', [0.1, 6], { expectIf: WIRE_TO_WIRE }),
          wire('mS', 'Secondary to neutral', [0.05, 3], { naIf: NO_SECONDARY, expectIf: [WIRE_TO_WIRE, HAS_SECONDARY] }),
          wire('mT', '{telecom} to lowest neutral or secondary', [0.1, 8], {
            column: 'Measured: {telecom} to lowest neutral or secondary',
            expectIf: WIRE_TO_WIRE, expectUnless: { key: 'telPlant', is: 'No' },
          }),
          {
            type: 'computed',
            key: 'separations',
            label: 'Separations, worked out for you',
            unit: 'm',
            rows: [
              { key: 'neuPri', label: 'Neutral to primary bolt', column: 'Separation: neutral to primary bolt', kind: 'diff', upper: 'gP', lower: 'gN', override: 'mP' },
              { key: 'secNeu', label: 'Secondary to neutral', column: 'Separation: secondary to neutral', kind: 'absdiff', a: 'gN', b: 'gS', override: 'mS' },
              { key: 'telLow', label: '{telecom} to lowest neutral or secondary', column: 'Separation: {telecom} to lowest neutral or secondary', kind: 'diff', upper: { computed: 'low' }, lower: 'gT', override: 'mT' },
              { key: 'low', label: 'Lowest neutral or secondary', column: 'Lowest neutral or secondary height', kind: 'min', of: ['gS', 'gN'] },
            ],
          },
          { type: 'heading', key: 'hOther', label: 'Other heights from ground' },
          ground('gDip', 'Top of {power} dip cable cover', [1, 12], {
            column: 'Ground to top of {power} dip cable cover',
            naIf: { key: 'powerDip', is: 'No' }, expectIf: { key: 'powerDip', is: 'Yes' },
          }),
          ground('gSL', 'Street light, lowest conductive part', [3, 15], {
            column: 'Ground to street light lowest conductive part',
            naIf: { key: 'streetLight', is: 'No' }, expectIf: { key: 'streetLight', in: ['Yes', 'Yes - Bonded'] },
          }),
          ground('gOther', 'Other', [0, 25]),
          { type: 'text', key: 'otherWhat', label: 'Other: what is it', expectIf: { key: 'gOther', filled: true } },
        ],
      },
      {
        key: 'spans',
        title: 'Spans',
        items: [
          { type: 'spanmap', key: 'spanMap', label: 'Span diagram' },
          { type: 'heading', key: 'hSpanText', label: 'Spans in words' },
          span(1, { expect: true, expectUnlessSpans: true }),
          span(2),
          span(3),
          span(4),
          { type: 'text', key: 'stub', label: 'Stub pole : Direction and distance', placeholder: 'direction and distance' },
          { type: 'heading', key: 'hMid', label: 'Mid-span' },
          { type: 'choice', key: 'midIssue', label: 'Mid-span clearance issue', options: YES_NO },
          { type: 'text', key: 'midBetween', label: 'Between pole #', column: 'Mid-span between pole #', mono: true, naIf: { key: 'midIssue', is: 'No' }, expectIf: { key: 'midIssue', is: 'Yes' } },
          { type: 'text', key: 'midAnd', label: 'And pole #', column: 'Mid-span and pole #', mono: true, naIf: { key: 'midIssue', is: 'No' }, expectIf: { key: 'midIssue', is: 'Yes' } },
          { type: 'number', key: 'sag', label: 'Sag', unit: 'm', soft: [0, 10] },
          { type: 'heading', key: 'hNew', label: 'Proposed new pole' },
          { type: 'note', key: 'newLocation', label: 'Where the new pole would go', column: 'Proposed new pole location', rows: 3 },
        ],
      },
      {
        key: 'photos',
        title: 'Photos and notes',
        items: [
          { type: 'photos', key: 'photos', label: 'Photos for this pole' },
          { type: 'note', key: 'notes', label: 'Notes', rows: 6 },
          { type: 'review', key: 'review', label: 'Before you save' },
        ],
      },
    ],
  },
};
