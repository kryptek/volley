# Third-party notices: volley-desk

The Volley Desk is licensed under Apache-2.0 (see the repository-root `LICENSE`), **except** for
the third-party code and assets listed here, which keep their own licence.

## React Bits (`src/rb/`)

Every component under `src/rb/` was installed from the [React Bits](https://reactbits.dev)
shadcn registry (source: <https://github.com/DavidHDev/react-bits>), in some cases with small
local adaptations (see the package README, "React Bits"). These files are **not** Apache-2.0.
They are distributed here only as part of the Volley Desk application, under the upstream
licence reproduced below: MIT with the Commons Clause License Condition v1.0, which forbids
selling, sublicensing or redistributing the components themselves (alone, in a bundle, or as a
ported version). If you reuse code from `src/rb/` outside this application, that restriction
applies to you; take the components from upstream instead.

The licence text below is copied verbatim from the upstream `LICENSE.md`.

---

MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software **as part of an application, website, or product**, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

## Commons Clause Restriction

You may use this Software, including for any commercial purpose, **so long as you do not sell, sublicense, or redistribute the components themselves-whether alone, in a bundle, or as a ported version.**

The same restriction covers the React Bits tools (Background Studio, Texture Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the sounds in the sound library. **You may not sell, sublicense, or redistribute the tools or the sounds themselves, or offer the tools or a substantially similar copy of them as a hosted service-whether alone, in a bundle, or as a ported version.**

What you make with the tools is yours to use. You can use exported code, images, videos, and audio files in any personal or commercial application, website, or product, including paid ones. **You may not sell or redistribute the exports on their own, either individually or as the product itself, such as a sound, texture, background, or template pack.**

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Symbols Nerd Font Mono (`public/fonts/SymbolsNerdFontMono-Regular.ttf`)

`SymbolsNerdFontMono-Regular.ttf` is the symbols-only font of the
[Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) project, copied unmodified from the
`NerdFontsSymbolsOnly` archive of release **v3.5.1**. The Desk serves it itself (no CDN) as the
last family of the Terminal's font stack (`--f-term` in `src/styles/desk.css`), limited by
`unicode-range` to the Private Use Areas, so Nerd Font and powerline glyphs in an agent's screen
render. It is **not** Apache-2.0.

The Nerd Fonts project is MIT-licensed; the text below is copied verbatim from the archive's
`LICENSE`.

---

The MIT License (MIT)

Copyright (c) 2014 Ryan L McIntyre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

The glyphs in the font come from these icon sets, each under its own licence (the table is the
archive's `README.md`, "Icon sets"):

| Icon set name          | upstream                                              | version         | license     |
|------------------------|-------------------------------------------------------|-----------------|-------------|
| Codicons               | https://github.com/microsoft/vscode-codicons          | 0.0.45          | CC BY 4.0   |
| Devicons               | https://github.com/devicons/devicon                   | 2.17.0          | MIT         |
| extraglyphs            | https://github.com/source-foundry/Hack                | -               | MIT         |
| Font Awesome           | https://github.com/FortAwesome/Font-Awesome           | 6.5.1           | CC BY 4.0   |
| Font Awesome Extension | https://github.com/AndreLZGava/font-awesome-extension | 0.0.3           | MIT         |
| Font Logos             | https://github.com/lukas-w/font-logos                 | 1.3.0           | unlicensed  |
| MaterialDesign         | https://github.com/Templarian/MaterialDesign-Font     | Oct 6, 2022     | Apache 2.0  |
| Octicons               | https://github.com/primer/octicons                    | 18.3.0          | MIT         |
| Seti and original      | https://github.com/jesseweed/seti-ui                  | 0.8.1           | MIT         |
| Pomicons               | https://github.com/gabrielelana/pomicons              | 1.001           | OFL 1.1 RFN |
| Powerline Extra        | https://github.com/ryanoasis/powerline-extra-symbols  | 1.200           | MIT         |
| Powerline Symbols      | https://github.com/powerline/powerline                | 1.000 (ca 2013) | MIT         |
| Power Symbols IEC      | https://github.com/jloughry/Unicode                   | Feb 2015        | MIT         |
| Weather Icons          | https://github.com/erikflowers/weather-icons          | 2.0.10 (1.100)  | OFL 1.1     |
