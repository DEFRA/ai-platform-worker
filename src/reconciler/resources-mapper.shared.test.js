import { readFileSync } from 'node:fs'

import { resourcesOf } from '#/reconciler/resources-mapper.js'

// The cases the workflows repository tests its own copy of this mapping with
// (`ai-platform-workflows` `src/resources.js`). Both repositories flatten the
// same run report into the event's `resources[]`, and the first `deployed`
// event to arrive decides what the backend stores, so the two copies of this
// file must stay identical (README, "Shared fixture").
const SHARED_CASES = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/team-resources-cases.json', import.meta.url),
    'utf8'
  )
)

describe('#resources-mapper against the fixture shared with the workflows', () => {
  test.each(SHARED_CASES.map((entry) => [entry.name, entry]))(
    'R3-F3: %s',
    (_name, { report, team, expected }) => {
      expect(resourcesOf(report, team)).toEqual(expected)
    }
  )
})
