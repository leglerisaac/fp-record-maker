# Fisher-Price Record Maker

A web app for creating custom Fisher-Price record player music discs. Takes one or two MIDI files as input and creates a 3D-printable STL file.

## Features
- Upload one MIDI for Side A, optional second MIDI for Side B
- Auto-maps notes to the Fisher-Price comb note set with octave folding
- Generates a printable STL disc with curved center labels
- Progress indicators during conversion

## Requirements
- Node.js 18+ (recommended)
- npm

## Local Setup
```bash
cd /mnt/c/Users/Isaac/fisher-price/app
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## Docker
### Build and run
```bash
docker build -t fp-record-maker .
docker run --rm -p 3000:3000 fp-record-maker
```

### Docker Compose
```bash
docker compose up --build
```

Then open `http://localhost:3000`.

## Usage
1. Click “Select MIDI (Side A)” and choose a `.mid` or `.midi` file.
2. (Optional) Add a second MIDI for Side B.
3. Click “Convert to STL”.
4. Download the generated `.stl` and open it in your slicer.

## Notes
- The disc label text comes from the MIDI filename (minus extension).
- The disc is modeled at ~121.16 mm diameter and 3.0 mm thickness.
- For best results, print with the disc laying flat (largest side down).

## Troubleshooting
- If conversion fails, try a simpler MIDI (fewer tracks/notes) to verify your setup.
- If Cura reports an empty STL, ensure the server completed the conversion and re-download.

## License
GNU General Public License (GPL).
