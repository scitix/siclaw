import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { TimezoneCombobox } from "./TimezoneCombobox"

// portal-web ships no DOM environment or @testing-library, so the open/typing
// interactions cannot be driven here — the same constraint CapabilityGroupSelector
// documents. The list/label/filter rules those interactions run on live in
// ../lib/timezones and are unit-tested there; what is left for this file is the
// closed-state render contract, which is a pure function of `value`.
const render = (value: string) =>
  renderToStaticMarkup(<TimezoneCombobox value={value} onChange={() => {}} />)

describe("TimezoneCombobox — closed-state render contract", () => {
  it("shows the selected zone", () => {
    expect(render("Asia/Shanghai")).toContain('value="Asia/Shanghai"')
  })

  // "Unset" and "UTC" behave the same at runtime today, so the empty state has
  // to say which one it is — otherwise the field reads as "no opinion" when it
  // is in fact a decision the model acts on.
  it("says what an empty value means rather than leaving the field blank", () => {
    const html = render("")
    expect(html).toContain("the agent uses UTC")
  })

  // The clear button is what puts the field back to unset; without it a picker
  // that only ever assigns is a one-way door.
  it("offers a clear affordance only when something is selected", () => {
    expect(render("Asia/Shanghai")).toContain('title="Clear"')
    expect(render("")).not.toContain('title="Clear"')
  })

  // Every control sits inside the agent form, so a button defaulting to
  // type="submit" would save the agent on a click meant to open the list.
  it("never renders a submit-typed button", () => {
    const html = render("Asia/Shanghai")
    expect(html).toContain("<button")
    expect(html).not.toMatch(/<button(?![^>]*type="button")/)
  })
})
