/** A step whose content has not landed yet: says so, and Continue moves on. */
export function StepStub() {
  return (
    <div className="gs-card gs-stub">
      <p className="gs-stub-title">This step is on its way.</p>
      <p className="dim">Nothing here changes anything yet: Continue to the next step.</p>
    </div>
  );
}
