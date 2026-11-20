# Third-party software and data

PixelForge 3D itself is licensed under GPL-3.0 (see `LICENSE`). It uses the following, each under its own licence.

## Libraries

| Name | Licence | Where |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT | npm dependency (rendering, model loaders, controls) |
| [fflate](https://github.com/101arrowz/fflate) | MIT | npm dependency (ZIP export) |
| [Draco](https://github.com/google/draco) decoder | Apache-2.0 | `public/draco/`, copied unchanged from three.js (`examples/jsm/libs/draco/`) |
| [Inter](https://github.com/rsms/inter) typeface, packaged by [Fontsource](https://github.com/fontsource/font-files) | SIL Open Font License 1.1 | npm dependency (the typeface of the app, served with it) |
| [Vite](https://github.com/vitejs/vite) | MIT | build tool only, not part of the built site |

The full licence texts are in each package under `node_modules/` after `npm install`, and at the links above.

## Colour palettes

The fixed palettes in `src/presets.js` are lists of colour values published by their authors for free use:

| Palette | Author |
|---|---|
| PICO-8 | Lexaloffle Games |
| Sweetie 16 | GrafxKid |
| DawnBringer 16, DawnBringer 32 | DawnBringer |
| Endesga 32 | ENDESGA |
| NES, Game Boy, Game Boy Pocket, Commodore 64 | Commonly used approximations of each system's hardware colours |

## Drawing styles

The shading styles were tuned by measuring how hand-drawn sprites are shaded (number of tones, lightness steps, hue shift, share of shadow). Only those measurements are used. No sprite or other artwork is included.
