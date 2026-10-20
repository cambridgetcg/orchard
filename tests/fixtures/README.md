# Test fixtures

`capacitor-8.5.3-spm/ios/` is the iOS SPM template that ships inside `@capacitor/cli` 8.5.3
(`assets/ios-spm-template.tar.gz`, MIT licence, Ionic), as `npx cap add ios` lays it down, minus
the PNG artwork. The only edits are the two `cap add` itself makes: `PRODUCT_BUNDLE_IDENTIFIER`
(set to `com.example.orchard.fixture`) and `CFBundleDisplayName`. `capacitor.config.json` and
`package.json` stand in for the web project around it.

It is the "before" state: deployment target 15.0, device family 1,2, three iPhone orientations,
`armv7`, no `ITSAppUsesNonExemptEncryption`, no privacy manifest, no `ci_scripts`. Tests copy it
to a temporary directory before touching it; nothing writes here.
