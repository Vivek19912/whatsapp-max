# Vendored web fonts

These WOFF2 files are copied from the `@fontsource` 5.3.0 packages so the
production build never fetches fonts from Google:

| File | Family | Weights |
| --- | --- | --- |
| `inter-latin-wght-normal.woff2` | Inter | 100–900 (variable) |
| `roboto-latin-wght-normal.woff2` | Roboto | 300–700 (variable subset used by the app) |
| `open-sans-latin-wght-normal.woff2` | Open Sans | 300–800 (variable) |
| `poppins-latin-{300,400,500,600,700}-normal.woff2` | Poppins | 300, 400, 500, 600, 700 |
| `montserrat-latin-wght-normal.woff2` | Montserrat | 100–900 (variable) |
| `lato-latin-{300,400,700}-normal.woff2` | Lato | 300, 400, 700 |
| `nunito-sans-latin-wght-normal.woff2` | Nunito Sans | 200–1000 (variable) |
| `dm-sans-latin-wght-normal.woff2` | DM Sans | 400–700 (variable subset used by the workspace) |

They are loaded through `next/font/local` in `src/app/layout.tsx` and
`src/app/(dashboard)/workspace/page.tsx`.

## Licenses

All families are licensed under the SIL Open Font License, Version 1.1
(see `OFL.txt`).

- Inter: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)
- Roboto: Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic)
- Open Sans: Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans)
- Poppins: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)
- Montserrat: Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat)
- Lato: Copyright (c) 2010-2011 by tyPoland Lukasz Dziedzic (team@latofonts.com), with Reserved Font Name "Lato"
- Nunito Sans: Copyright 2016 The Nunito Sans Project Authors (https://github.com/Fonthausen/NunitoSans)
- DM Sans: Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts)

Source packages: `@fontsource-variable/{inter,roboto,open-sans,montserrat,nunito-sans,dm-sans}`
and `@fontsource/{poppins,lato}`, version 5.3.0.
