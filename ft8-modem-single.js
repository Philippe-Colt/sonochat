/**
 * MODE FRÉQUENCE UNIQUE — le modem tel qu'il était avant le décodage large bande
 * (commit eeb6e19), conservé à l'identique pour comparer sur le terrain (paramètres →
 * Réception). Seuls changent les noms (FT8_SINGLE, FT8ModemSingle) pour cohabiter avec
 * ft8-modem.js, et les méthodes ajoutées à la fin pour l'interface actuelle.
 * Capture et décodage à la fréquence du contexte audio (48 kHz), recherche à ±3 tons
 * autour de baseFreq, 6 candidats par passe.
 * Régénérer : git show eeb6e19:ft8-modem.js puis renommer (voir l'historique de ce fichier).
 */
/**
 * FT8ModemSingle - Modulation/Demodulation GFSK fidele au protocole FT8 (WSJT-X)
 *
 * Specifications FT8 :
 * - Modulation : 8-GFSK (Gaussian FSK, phase continue)
 * - 8 tons, espacement 6.25 Hz, duree symbole 0.16 s
 * - 79 symboles : S7 D29 S7 D29 S7 (Costas + data)
 * - Encodage : 77 bits payload -> CRC-14 -> LDPC(174,91) -> Gray code -> 58 symboles
 * - Bande passante : 50 Hz
 * - Duree totale : 12.64 s
 *
 * References :
 * - WSJT-X source (gen_ft8wave.f90, gfsk_pulse.f90)
 * - ft8_lib par kgoba (constants.c, encode.c)
 * - "The FT4 and FT8 Communication Protocols" (K1JT, K9AN, G4WJS)
 */

// ============================================================
// FT8 Constants
// ============================================================

const FT8_SINGLE = {
  // Timing
  SYMBOL_PERIOD: 0.160,      // secondes
  TONE_SPACING: 6.25,        // Hz
  NUM_TONES: 8,
  NUM_SYMBOLS: 79,
  NUM_DATA_SYMBOLS: 58,
  NUM_SYNC_SYMBOLS: 21,
  TX_DURATION: 12.64,         // 79 * 0.16
  TX_MUTE_TAIL_MS: 300,       // silence RX apres emission (anti auto-decodage)

  // Extended modes
  MODE_STANDARD: 'standard',
  MODE_MULTI_FRAME: 'multi-frame',
  MODE_EXTENDED: 'extended',

  // Multi-frame (trames DATA binaires, voir arq.js)
  MULTI_FRAME_USEFUL_CHARS: 10,
  MULTI_FRAME_MAX_CHUNKS: 16,
  MULTI_FRAME_GAP: 0.5,          // seconds between frames

  // Bande audio utile et canaux par station (mesure : node tests/passband.js, chaîne BLU
  // 300-2 700 Hz simulée). Décodage identique de 500 à 2 500 Hz, dégradé aux bords du
  // filtre ; sous ~1 350 Hz l'harmonique 2 (-38 dBc) retombe dans la bande : canaux
  // attribués d'abord de 1 400 à 2 500 Hz, puis de 500 à 1 340 Hz.
  TX_BAND_MIN: 500,
  TX_BAND_MAX: 2500,
  CHANNEL_STEP: 60,              // Hz entre canaux (signal 50 Hz + marge)
  CLEAN_BAND_MIN: 1400,          // au-dessus : harmoniques hors bande

  // PTT par tonalite (cable VOX type Digirig) : tonalite continue sur le canal
  // droit, detectee par le cable qui met le PTT a la masse ; FT8 sur le gauche.
  // Plus aigue = detection plus rapide.
  VOX_TONE_HZ: 2000,
  VOX_TONE_LEVEL: 0.8,

  // Telemetrie FT8 (i3=0, n3=5) : 71 bits libres, conteneur des trames du protocole
  N3_TELEMETRY: 5,

  // Extended frame
  EXTENDED_BLOCK_SYMBOLS: 72,     // S7 D29 S7 D29 per block
  EXTENDED_MAX_BLOCKS: 10,

  // Reception
  RX_MAX_CANDIDATES: 6,          // distinct time slots refined + decoded per pass
  // < 36: an extended frame has a Costas every 36 symbols, so a half-block
  // shifted window syncs as well as the true one and must not suppress it
  RX_MIN_CANDIDATE_SPACING: 20,  // symbols between two candidates of a pass
  RX_UNDECODED_MIN_SCORE: 40,    // Costas score of a lost frame worth reporting
  RX_UNDECODED_SETTLE: 3,        // s after a lost frame before reporting it
  RX_TAIL_SYMBOLS: 4,            // symbols checked after a text frame (continuation)
  RX_NOISE_CONTRAST: 3.9,        // mean max/mean-others tone ratio over 4 symbols of noise (measured)

  // GFSK
  BT: 2.0,                   // Gaussian filter BT product
  HMOD: 1.0,                 // modulation index

  // LDPC
  LDPC_N: 174,               // codeword length
  LDPC_K: 91,                // info bits (77 msg + 14 CRC)
  LDPC_M: 83,                // parity bits

  // CRC
  CRC_POLY: 0x2757,
  CRC_WIDTH: 14,

  // Payload
  PAYLOAD_BITS: 77,

  // Alphabet for free text (42 chars)
  CHARSET: ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?',

  // Costas 7x7 sync pattern
  COSTAS: [3, 1, 4, 0, 6, 5, 2],

  // Gray code map (3-bit binary -> tone)
  GRAY_MAP: [0, 1, 3, 2, 5, 6, 4, 7],

  // Inverse Gray code map (tone -> 3-bit binary)
  GRAY_UNMAP: [0, 1, 3, 2, 6, 4, 5, 7],

  // LDPC Generator Matrix (83 x 12 bytes = 83 x 91 bits, bitpacked MSB-first)
  LDPC_GENERATOR: [
    [0x83,0x29,0xce,0x11,0xbf,0x31,0xea,0xf5,0x09,0xf2,0x7f,0xc0],
    [0x76,0x1c,0x26,0x4e,0x25,0xc2,0x59,0x33,0x54,0x93,0x13,0x20],
    [0xdc,0x26,0x59,0x02,0xfb,0x27,0x7c,0x64,0x10,0xa1,0xbd,0xc0],
    [0x1b,0x3f,0x41,0x78,0x58,0xcd,0x2d,0xd3,0x3e,0xc7,0xf6,0x20],
    [0x09,0xfd,0xa4,0xfe,0xe0,0x41,0x95,0xfd,0x03,0x47,0x83,0xa0],
    [0x07,0x7c,0xcc,0xc1,0x1b,0x88,0x73,0xed,0x5c,0x3d,0x48,0xa0],
    [0x29,0xb6,0x2a,0xfe,0x3c,0xa0,0x36,0xf4,0xfe,0x1a,0x9d,0xa0],
    [0x60,0x54,0xfa,0xf5,0xf3,0x5d,0x96,0xd3,0xb0,0xc8,0xc3,0xe0],
    [0xe2,0x07,0x98,0xe4,0x31,0x0e,0xed,0x27,0x88,0x4a,0xe9,0x00],
    [0x77,0x5c,0x9c,0x08,0xe8,0x0e,0x26,0xdd,0xae,0x56,0x31,0x80],
    [0xb0,0xb8,0x11,0x02,0x8c,0x2b,0xf9,0x97,0x21,0x34,0x87,0xc0],
    [0x18,0xa0,0xc9,0x23,0x1f,0xc6,0x0a,0xdf,0x5c,0x5e,0xa3,0x20],
    [0x76,0x47,0x1e,0x83,0x02,0xa0,0x72,0x1e,0x01,0xb1,0x2b,0x80],
    [0xff,0xbc,0xcb,0x80,0xca,0x83,0x41,0xfa,0xfb,0x47,0xb2,0xe0],
    [0x66,0xa7,0x2a,0x15,0x8f,0x93,0x25,0xa2,0xbf,0x67,0x17,0x00],
    [0xc4,0x24,0x36,0x89,0xfe,0x85,0xb1,0xc5,0x13,0x63,0xa1,0x80],
    [0x0d,0xff,0x73,0x94,0x14,0xd1,0xa1,0xb3,0x4b,0x1c,0x27,0x00],
    [0x15,0xb4,0x88,0x30,0x63,0x6c,0x8b,0x99,0x89,0x49,0x72,0xe0],
    [0x29,0xa8,0x9c,0x0d,0x3d,0xe8,0x1d,0x66,0x54,0x89,0xb0,0xe0],
    [0x4f,0x12,0x6f,0x37,0xfa,0x51,0xcb,0xe6,0x1b,0xd6,0xb9,0x40],
    [0x99,0xc4,0x72,0x39,0xd0,0xd9,0x7d,0x3c,0x84,0xe0,0x94,0x00],
    [0x19,0x19,0xb7,0x51,0x19,0x76,0x56,0x21,0xbb,0x4f,0x1e,0x80],
    [0x09,0xdb,0x12,0xd7,0x31,0xfa,0xee,0x0b,0x86,0xdf,0x6b,0x80],
    [0x48,0x8f,0xc3,0x3d,0xf4,0x3f,0xbd,0xee,0xa4,0xea,0xfb,0x40],
    [0x82,0x74,0x23,0xee,0x40,0xb6,0x75,0xf7,0x56,0xeb,0x5f,0xe0],
    [0xab,0xe1,0x97,0xc4,0x84,0xcb,0x74,0x75,0x71,0x44,0xa9,0xa0],
    [0x2b,0x50,0x0e,0x4b,0xc0,0xec,0x5a,0x6d,0x2b,0xdb,0xdd,0x00],
    [0xc4,0x74,0xaa,0x53,0xd7,0x02,0x18,0x76,0x16,0x69,0x36,0x00],
    [0x8e,0xba,0x1a,0x13,0xdb,0x33,0x90,0xbd,0x67,0x18,0xce,0xc0],
    [0x75,0x38,0x44,0x67,0x3a,0x27,0x78,0x2c,0xc4,0x20,0x12,0xe0],
    [0x06,0xff,0x83,0xa1,0x45,0xc3,0x70,0x35,0xa5,0xc1,0x26,0x80],
    [0x3b,0x37,0x41,0x78,0x58,0xcc,0x2d,0xd3,0x3e,0xc3,0xf6,0x20],
    [0x9a,0x4a,0x5a,0x28,0xee,0x17,0xca,0x9c,0x32,0x48,0x42,0xc0],
    [0xbc,0x29,0xf4,0x65,0x30,0x9c,0x97,0x7e,0x89,0x61,0x0a,0x40],
    [0x26,0x63,0xae,0x6d,0xdf,0x8b,0x5c,0xe2,0xbb,0x29,0x48,0x80],
    [0x46,0xf2,0x31,0xef,0xe4,0x57,0x03,0x4c,0x18,0x14,0x41,0x80],
    [0x3f,0xb2,0xce,0x85,0xab,0xe9,0xb0,0xc7,0x2e,0x06,0xfb,0xe0],
    [0xde,0x87,0x48,0x1f,0x28,0x2c,0x15,0x39,0x71,0xa0,0xa2,0xe0],
    [0xfc,0xd7,0xcc,0xf2,0x3c,0x69,0xfa,0x99,0xbb,0xa1,0x41,0x20],
    [0xf0,0x26,0x14,0x47,0xe9,0x49,0x0c,0xa8,0xe4,0x74,0xce,0xc0],
    [0x44,0x10,0x11,0x58,0x18,0x19,0x6f,0x95,0xcd,0xd7,0x01,0x20],
    [0x08,0x8f,0xc3,0x1d,0xf4,0xbf,0xbd,0xe2,0xa4,0xea,0xfb,0x40],
    [0xb8,0xfe,0xf1,0xb6,0x30,0x77,0x29,0xfb,0x0a,0x07,0x8c,0x00],
    [0x5a,0xfe,0xa7,0xac,0xcc,0xb7,0x7b,0xbc,0x9d,0x99,0xa9,0x00],
    [0x49,0xa7,0x01,0x6a,0xc6,0x53,0xf6,0x5e,0xcd,0xc9,0x07,0x60],
    [0x19,0x44,0xd0,0x85,0xbe,0x4e,0x7d,0xa8,0xd6,0xcc,0x7d,0x00],
    [0x25,0x1f,0x62,0xad,0xc4,0x03,0x2f,0x0e,0xe7,0x14,0x00,0x20],
    [0x56,0x47,0x1f,0x87,0x02,0xa0,0x72,0x1e,0x00,0xb1,0x2b,0x80],
    [0x2b,0x8e,0x49,0x23,0xf2,0xdd,0x51,0xe2,0xd5,0x37,0xfa,0x00],
    [0x6b,0x55,0x0a,0x40,0xa6,0x6f,0x47,0x55,0xde,0x95,0xc2,0x60],
    [0xa1,0x8a,0xd2,0x8d,0x4e,0x27,0xfe,0x92,0xa4,0xf6,0xc8,0x40],
    [0x10,0xc2,0xe5,0x86,0x38,0x8c,0xb8,0x2a,0x3d,0x80,0x75,0x80],
    [0xef,0x34,0xa4,0x18,0x17,0xee,0x02,0x13,0x3d,0xb2,0xeb,0x00],
    [0x7e,0x9c,0x0c,0x54,0x32,0x5a,0x9c,0x15,0x83,0x6e,0x00,0x00],
    [0x36,0x93,0xe5,0x72,0xd1,0xfd,0xe4,0xcd,0xf0,0x79,0xe8,0x60],
    [0xbf,0xb2,0xce,0xc5,0xab,0xe1,0xb0,0xc7,0x2e,0x07,0xfb,0xe0],
    [0x7e,0xe1,0x82,0x30,0xc5,0x83,0xcc,0xcc,0x57,0xd4,0xb0,0x80],
    [0xa0,0x66,0xcb,0x2f,0xed,0xaf,0xc9,0xf5,0x26,0x64,0x12,0x60],
    [0xbb,0x23,0x72,0x5a,0xbc,0x47,0xcc,0x5f,0x4c,0xc4,0xcd,0x20],
    [0xde,0xd9,0xdb,0xa3,0xbe,0xe4,0x0c,0x59,0xb5,0x60,0x9b,0x40],
    [0xd9,0xa7,0x01,0x6a,0xc6,0x53,0xe6,0xde,0xcd,0xc9,0x03,0x60],
    [0x9a,0xd4,0x6a,0xed,0x5f,0x70,0x7f,0x28,0x0a,0xb5,0xfc,0x40],
    [0xe5,0x92,0x1c,0x77,0x82,0x25,0x87,0x31,0x6d,0x7d,0x3c,0x20],
    [0x4f,0x14,0xda,0x82,0x42,0xa8,0xb8,0x6d,0xca,0x73,0x35,0x20],
    [0x8b,0x8b,0x50,0x7a,0xd4,0x67,0xd4,0x44,0x1d,0xf7,0x70,0xe0],
    [0x22,0x83,0x1c,0x9c,0xf1,0x16,0x94,0x67,0xad,0x04,0xb6,0x80],
    [0x21,0x3b,0x83,0x8f,0xe2,0xae,0x54,0xc3,0x8e,0xe7,0x18,0x00],
    [0x5d,0x92,0x6b,0x6d,0xd7,0x1f,0x08,0x51,0x81,0xa4,0xe1,0x20],
    [0x66,0xab,0x79,0xd4,0xb2,0x9e,0xe6,0xe6,0x95,0x09,0xe5,0x60],
    [0x95,0x81,0x48,0x68,0x2d,0x74,0x8a,0x38,0xdd,0x68,0xba,0xa0],
    [0xb8,0xce,0x02,0x0c,0xf0,0x69,0xc3,0x2a,0x72,0x3a,0xb1,0x40],
    [0xf4,0x33,0x1d,0x6d,0x46,0x16,0x07,0xe9,0x57,0x52,0x74,0x60],
    [0x6d,0xa2,0x3b,0xa4,0x24,0xb9,0x59,0x61,0x33,0xcf,0x9c,0x80],
    [0xa6,0x36,0xbc,0xbc,0x7b,0x30,0xc5,0xfb,0xea,0xe6,0x7f,0xe0],
    [0x5c,0xb0,0xd8,0x6a,0x07,0xdf,0x65,0x4a,0x90,0x89,0xa2,0x00],
    [0xf1,0x1f,0x10,0x68,0x48,0x78,0x0f,0xc9,0xec,0xdd,0x80,0xa0],
    [0x1f,0xbb,0x53,0x64,0xfb,0x8d,0x2c,0x9d,0x73,0x0d,0x5b,0xa0],
    [0xfc,0xb8,0x6b,0xc7,0x0a,0x50,0xc9,0xd0,0x2a,0x5d,0x03,0x40],
    [0xa5,0x34,0x43,0x30,0x29,0xea,0xc1,0x5f,0x32,0x2e,0x34,0xc0],
    [0xc9,0x89,0xd9,0xc7,0xc3,0xd3,0xb8,0xc5,0x5d,0x75,0x13,0x00],
    [0x7b,0xb3,0x8b,0x2f,0x01,0x86,0xd4,0x66,0x43,0xae,0x96,0x20],
    [0x26,0x44,0xeb,0xad,0xeb,0x44,0xb9,0x46,0x7d,0x1f,0x42,0xc0],
    [0x60,0x8c,0xc8,0x57,0x59,0x4b,0xfb,0xb5,0x5d,0x69,0x60,0x00],
  ],

  // LDPC parity check matrix Nm (83 rows x 7 cols, 1-origin, 0=unused)
  LDPC_NM: [
    [4,31,59,91,92,96,153],[5,32,60,93,115,146,0],[6,24,61,94,122,151,0],
    [7,33,62,95,96,143,0],[8,25,63,83,93,96,148],[6,32,64,97,126,138,0],
    [5,34,65,78,98,107,154],[9,35,66,99,139,146,0],[10,36,67,100,107,126,0],
    [11,37,67,87,101,139,158],[12,38,68,102,105,155,0],[13,39,69,103,149,162,0],
    [8,40,70,82,104,114,145],[14,41,71,88,102,123,156],[15,42,59,106,123,159,0],
    [1,33,72,106,107,157,0],[16,43,73,108,141,160,0],[17,37,74,81,109,131,154],
    [11,44,75,110,121,166,0],[45,55,64,111,130,161,173],[8,46,71,112,119,166,0],
    [18,36,76,89,113,114,143],[19,38,77,104,116,163,0],[20,47,70,92,138,165,0],
    [2,48,74,113,128,160,0],[21,45,78,83,117,121,151],[22,47,58,118,127,164,0],
    [16,39,62,112,134,158,0],[23,43,79,120,131,145,0],[19,35,59,73,110,125,161],
    [20,36,63,94,136,161,0],[14,31,79,98,132,164,0],[3,44,80,124,127,169,0],
    [19,46,81,117,135,167,0],[7,49,58,90,100,105,168],[12,50,61,118,119,144,0],
    [13,51,64,114,118,157,0],[24,52,76,129,148,149,0],[25,53,69,90,101,130,156],
    [20,46,65,80,120,140,170],[21,54,77,100,140,171,0],[35,82,133,142,171,174,0],
    [14,30,83,113,125,170,0],[4,29,68,120,134,173,0],[1,4,52,57,86,136,152],
    [26,51,56,91,122,137,168],[52,84,110,115,145,168,0],[7,50,81,99,132,173,0],
    [23,55,67,95,172,174,0],[26,41,77,109,141,148,0],[2,27,41,61,62,115,133],
    [27,40,56,124,125,126,0],[18,49,55,124,141,167,0],[6,33,85,108,116,156,0],
    [28,48,70,85,105,129,158],[9,54,63,131,147,155,0],[22,53,68,109,121,174,0],
    [3,13,48,78,95,123,0],[31,69,133,150,155,169,0],[12,43,66,89,97,135,159],
    [5,39,75,102,136,167,0],[2,54,86,101,135,164,0],[15,56,87,108,119,171,0],
    [10,44,82,91,111,144,149],[23,34,71,94,127,153,0],[11,49,88,92,142,157,0],
    [29,34,87,97,147,162,0],[30,50,60,86,137,142,162],[10,53,66,84,112,128,165],
    [22,57,85,93,140,159,0],[28,32,72,103,132,166,0],[28,29,84,88,117,143,150],
    [1,26,45,80,128,147,0],[17,27,89,103,116,153,0],[51,57,98,163,165,172,0],
    [21,37,73,138,152,169,0],[16,47,76,130,137,154,0],[3,24,30,72,104,139,0],
    [9,40,90,106,134,151,0],[15,58,60,74,111,150,163],[18,42,79,144,146,152,0],
    [25,38,65,99,122,160,0],[17,42,75,129,170,172,0],
  ],

  // LDPC Mn matrix (174 rows x 3 cols, 1-origin)
  LDPC_MN: [
    [16,45,73],[25,51,62],[33,58,78],[1,44,45],[2,7,61],[3,6,54],[4,35,48],
    [5,13,21],[8,56,79],[9,64,69],[10,19,66],[11,36,60],[12,37,58],[14,32,43],
    [15,63,80],[17,28,77],[18,74,83],[22,53,81],[23,30,34],[24,31,40],[26,41,76],
    [27,57,70],[29,49,65],[3,38,78],[5,39,82],[46,50,73],[51,52,74],[55,71,72],
    [44,67,72],[43,68,78],[1,32,59],[2,6,71],[4,16,54],[7,65,67],[8,30,42],
    [9,22,31],[10,18,76],[11,23,82],[12,28,61],[13,52,79],[14,50,51],[15,81,83],
    [17,29,60],[19,33,64],[20,26,73],[21,34,40],[24,27,77],[25,55,58],[35,53,66],
    [36,48,68],[37,46,75],[38,45,47],[39,57,69],[41,56,62],[20,49,53],[46,52,63],
    [45,70,75],[27,35,80],[1,15,30],[2,68,80],[3,36,51],[4,28,51],[5,31,56],
    [6,20,37],[7,40,82],[8,60,69],[9,10,49],[11,44,57],[12,39,59],[13,24,55],
    [14,21,65],[16,71,78],[17,30,76],[18,25,80],[19,61,83],[22,38,77],[23,41,50],
    [7,26,58],[29,32,81],[33,40,73],[18,34,48],[13,42,64],[5,26,43],[47,69,72],
    [54,55,70],[45,62,68],[10,63,67],[14,66,72],[22,60,74],[35,39,79],[1,46,64],
    [1,24,66],[2,5,70],[3,31,65],[4,49,58],[1,4,5],[6,60,67],[7,32,75],
    [8,48,82],[9,35,41],[10,39,62],[11,14,61],[12,71,74],[13,23,78],[11,35,55],
    [15,16,79],[7,9,16],[17,54,63],[18,50,57],[19,30,47],[20,64,80],[21,28,69],
    [22,25,43],[13,22,37],[2,47,51],[23,54,74],[26,34,72],[27,36,37],[21,36,63],
    [29,40,44],[19,26,57],[3,46,82],[14,15,58],[33,52,53],[30,43,52],[6,9,52],
    [27,33,65],[25,69,73],[38,55,83],[20,39,77],[18,29,56],[32,48,71],[42,51,59],
    [28,44,79],[34,60,62],[31,45,61],[46,68,77],[6,24,76],[8,10,78],[40,41,70],
    [17,50,53],[42,66,68],[4,22,72],[36,64,81],[13,29,47],[2,8,81],[56,67,73],
    [5,38,50],[12,38,64],[59,72,80],[3,26,79],[45,76,81],[1,65,74],[7,18,77],
    [11,56,59],[14,39,54],[16,37,66],[10,28,55],[15,60,70],[17,25,82],[20,30,31],
    [12,67,68],[23,75,80],[27,32,62],[24,69,75],[19,21,71],[34,53,61],[35,46,47],
    [33,59,76],[40,43,83],[41,42,63],[49,75,83],[20,44,48],[42,49,57],
  ],

  // Number of entries per Nm row
  LDPC_NUM_ROWS: [
    7,6,6,6,7,6,7,6,6,7,6,6,7,7,6,6,6,7,6,7,6,7,6,6,6,7,6,6,6,7,6,6,
    6,6,7,6,6,6,7,7,6,6,6,6,7,7,6,6,6,6,7,6,6,6,7,6,6,6,6,7,6,6,6,7,
    6,6,6,7,7,6,6,7,6,6,6,6,6,6,6,7,6,6,6,
  ],
};

// ============================================================
// FT8 Modem Class
// ============================================================

class FT8ModemSingle {

  constructor(options = {}) {
    this.baseFreq = options.baseFreq || 1000; // audio frequency of tone 0
    this.volume = options.volume || 0.8;

    this.audioCtx = null;
    this.analyser = null;
    this.mediaStream = null;
    this.listening = false;
    this.transmitting = false;

    // Serial PTT
    this.serialPort = null;
    this.pttSignal = 'RTS';       // 'RTS' or 'DTR'
    this.pttActiveHigh = true;    // true = assert high for TX
    // Le relais du poste met quelques dizaines de ms a commuter, et la sortie
    // audio a sa propre latence : sans marge, le debut ou la fin de la trame
    // partirait PTT relache.
    this.pttLeadMs = 100;         // PTT ferme -> debut du son
    this.pttTailMs = 150;         // fin du son -> PTT relache
    this.voxTone = false;         // PTT par tonalite sur le canal droit
    this._vox = null;             // {merger, osc, gain} pendant l'emission

    // Callbacks
    this.onFrame = null;      // ({text, telemetry, ext, blocks, absPos, absEnd, score})
    this.onUndecoded = null;  // ({absPos, score}) : synchro forte mais LDPC en echec
    this.onSpectrumData = null;
    this.onStatusChange = null;

    // Reception state
    this._listenRAF = null;
    this._rxBuffer = [];     // rolling buffer of detected symbols
    this._rxTimestamp = 0;

    // Precomputed GFSK pulse (computed on first use)
    this._gfskPulseCache = null;

    // Deduplication by absolute position (see _resetRxState)
    this._absWritten = 0;
    this._decodedSpans = [];
    this._reportedUndecoded = [];
    this._muteUntil = 0;

    // TX cancel support
    this._txAborted = false;
    this._txSource = null;    // current AudioBufferSourceNode
  }

  _ensureAudioContext() {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  // ============================================================
  // MESSAGE ENCODING (text -> 77 bits)
  // ============================================================

  /**
   * Encode free text (up to 13 chars) into 77 payload bits.
   * FT8 layout: [71 bits text (MSB first)] [n3=0 (3 bits)] [i3=0 (3 bits)]
   */
  static encodeText(text) {
    text = text.toUpperCase().padEnd(13, ' ').substring(0, 13);

    // Base-42 encode: treat as a big number in base 42
    // We use BigInt for precision (42^13 needs ~72 bits)
    let val = 0n;
    for (let i = 0; i < 13; i++) {
      let idx = FT8_SINGLE.CHARSET.indexOf(text[i]);
      if (idx < 0) idx = 0; // space for unknown chars
      val = val * 42n + BigInt(idx);
    }

    // 77 bits: [71 bits of text, MSB first] [n3=0 (3 bits)] [i3=0 (3 bits)]
    const bits = new Uint8Array(77);

    // Pack 71-bit text value into bits[0..70], MSB first
    for (let i = 0; i < 71; i++) {
      bits[i] = Number((val >> BigInt(70 - i)) & 1n);
    }
    // bits[71..73] = n3 = 0 (already zero)
    // bits[74..76] = i3 = 0 (already zero)

    return bits;
  }

  /**
   * Decode 77 payload bits back to free text.
   * Layout: [71 bits text] [n3 (3 bits)] [i3 (3 bits)]
   */
  static decodeText(bits) {
    // Check i3 (bits 74-76) and n3 (bits 71-73)
    const i3 = (bits[74] << 2) | (bits[75] << 1) | bits[76];
    const n3 = (bits[71] << 2) | (bits[72] << 1) | bits[73];

    if (i3 !== 0 || n3 !== 0) {
      return null; // Not free text
    }

    // Extract 71-bit value from bits[0..70]
    let val = 0n;
    for (let i = 0; i < 71; i++) {
      val = (val << 1n) | BigInt(bits[i]);
    }

    // Base-42 decode
    let text = '';
    for (let i = 12; i >= 0; i--) {
      const idx = Number(val % 42n);
      val = val / 42n;
      text = FT8_SINGLE.CHARSET[idx] + text;
    }

    return text.trimEnd();
  }

  /**
   * Encode a 71-bit value (BigInt) as an FT8 telemetry payload (i3=0, n3=5).
   */
  static encodeTelemetry(value71) {
    const bits = new Uint8Array(77);
    for (let i = 0; i < 71; i++) {
      bits[i] = Number((value71 >> BigInt(70 - i)) & 1n);
    }
    const n3 = FT8_SINGLE.N3_TELEMETRY;
    bits[71] = (n3 >> 2) & 1;
    bits[72] = (n3 >> 1) & 1;
    bits[73] = n3 & 1;
    return bits;
  }

  /**
   * Decode an FT8 telemetry payload back to its 71-bit value, or null.
   */
  static decodeTelemetry(bits) {
    const i3 = (bits[74] << 2) | (bits[75] << 1) | bits[76];
    const n3 = (bits[71] << 2) | (bits[72] << 1) | bits[73];
    if (i3 !== 0 || n3 !== FT8_SINGLE.N3_TELEMETRY) return null;
    let val = 0n;
    for (let i = 0; i < 71; i++) {
      val = (val << 1n) | BigInt(bits[i]);
    }
    return val;
  }

  // ============================================================
  // CRC-14
  // ============================================================

  /**
   * Compute CRC-14 over the 77 payload bits + 5 zero padding = 82 bits.
   * Exact replica of ftx_compute_crc() from ft8_lib/crc.c
   * Input: array of individual bits. Output: 14-bit CRC value.
   */
  static computeCRC14(payload77) {
    // Pack bits into bytes (MSB first), 77 bits + 5 zero pad = 82 bits = 11 bytes
    const numBits = 82;
    const bytes = new Uint8Array(11);
    for (let i = 0; i < 77; i++) {
      if (payload77[i]) {
        bytes[i >> 3] |= (0x80 >> (i & 7));
      }
    }
    // Remaining 5 bits are zero padding (already 0)

    // CRC-14 computation matching ft8_lib reference exactly
    const TOPBIT = 1 << (FT8_SINGLE.CRC_WIDTH - 1); // 1 << 13 = 0x2000
    let remainder = 0;
    let idx_byte = 0;

    for (let idx_bit = 0; idx_bit < numBits; idx_bit++) {
      if ((idx_bit & 7) === 0) {
        // Bring the next byte into the remainder
        remainder ^= (bytes[idx_byte] << (FT8_SINGLE.CRC_WIDTH - 8));
        idx_byte++;
      }

      if (remainder & TOPBIT) {
        remainder = ((remainder << 1) ^ FT8_SINGLE.CRC_POLY) & 0xFFFF;
      } else {
        remainder = (remainder << 1) & 0xFFFF;
      }
    }

    return remainder & ((TOPBIT << 1) - 1); // mask to 14 bits
  }

  /**
   * Check CRC-14 of 91-bit payload (77 msg + 14 CRC).
   */
  static checkCRC14(bits91) {
    const payload = bits91.slice(0, 77);
    const crcReceived = bits91.slice(77, 91).reduce((acc, b, i) =>
      acc | (b << (13 - i)), 0);
    const crcComputed = FT8ModemSingle.computeCRC14(payload);
    return crcReceived === crcComputed;
  }

  // ============================================================
  // LDPC(174,91) ENCODING
  // ============================================================

  /**
   * LDPC encode 91 information bits into 174-bit codeword.
   * Uses the systematic generator matrix: codeword = [info | parity]
   */
  static ldpcEncode(infoBits91) {
    const codeword = new Uint8Array(174);

    // First 91 bits = information bits (systematic part)
    codeword.set(infoBits91);

    // Compute 83 parity bits using the generator matrix
    for (let i = 0; i < 83; i++) {
      let parity = 0;
      const row = FT8_SINGLE.LDPC_GENERATOR[i];
      for (let j = 0; j < 91; j++) {
        // Generator matrix is bitpacked: row[j/8] bit (7 - j%8)
        const byteIdx = Math.floor(j / 8);
        const bitIdx = 7 - (j % 8);
        if ((row[byteIdx] >> bitIdx) & 1) {
          parity ^= infoBits91[j];
        }
      }
      codeword[91 + i] = parity;
    }

    return codeword;
  }

  // ============================================================
  // LDPC DECODING (Belief Propagation / Min-Sum)
  // ============================================================

  /**
   * LDPC decode using offset min-sum belief propagation.
   * Offset min-sum is more robust than scaled min-sum for FT8_SINGLE.
   * @param {Float32Array} llr - Log-likelihood ratios for 174 bits (positive = more likely 0)
   * @param {number} maxIter - Maximum iterations
   * @returns {Uint8Array|null} - Decoded 91 info bits or null if failed
   */
  static ldpcDecode(llr, maxIter = 50) {
    const N = FT8_SINGLE.LDPC_N;  // 174
    const M = FT8_SINGLE.LDPC_M;  // 83
    const OFFSET = 0.15;    // offset for min-sum (better than scaling for FT8)
    const SCALE = 0.75;     // additional scaling factor

    // Messages from variable nodes to check nodes
    const v2c = Array.from({ length: M }, () => new Float32Array(7));
    // Messages from check nodes to variable nodes
    const c2v = Array.from({ length: M }, () => new Float32Array(7));

    // Initialize v2c with channel LLRs
    for (let i = 0; i < M; i++) {
      const numCols = FT8_SINGLE.LDPC_NUM_ROWS[i];
      for (let j = 0; j < numCols; j++) {
        const varIdx = FT8_SINGLE.LDPC_NM[i][j] - 1;
        if (varIdx >= 0 && varIdx < N) {
          v2c[i][j] = llr[varIdx];
        }
      }
    }

    const decoded = new Uint8Array(N);
    let prevSyndrome = Infinity;

    for (let iter = 0; iter < maxIter; iter++) {
      // Check node update (offset min-sum)
      for (let i = 0; i < M; i++) {
        const numCols = FT8_SINGLE.LDPC_NUM_ROWS[i];
        for (let j = 0; j < numCols; j++) {
          let min1 = Infinity, min2 = Infinity;
          let signProd = 1;
          for (let k = 0; k < numCols; k++) {
            if (k === j) continue;
            const val = v2c[i][k];
            const absVal = Math.abs(val);
            if (absVal < min1) { min2 = min1; min1 = absVal; }
            else if (absVal < min2) { min2 = absVal; }
            if (val < 0) signProd *= -1;
          }
          // Offset min-sum: subtract offset, then scale, clamp to 0
          const minVal = Math.abs(v2c[i][j]) === min1 ? min2 : min1;
          c2v[i][j] = signProd * Math.max(0, minVal - OFFSET) * SCALE;
        }
      }

      // Variable node update
      const totalLLR = new Float32Array(N);
      for (let i = 0; i < N; i++) totalLLR[i] = llr[i];

      for (let i = 0; i < M; i++) {
        const numCols = FT8_SINGLE.LDPC_NUM_ROWS[i];
        for (let j = 0; j < numCols; j++) {
          const varIdx = FT8_SINGLE.LDPC_NM[i][j] - 1;
          if (varIdx >= 0 && varIdx < N) {
            totalLLR[varIdx] += c2v[i][j];
          }
        }
      }

      // Hard decision
      for (let i = 0; i < N; i++) {
        decoded[i] = totalLLR[i] < 0 ? 1 : 0;
      }

      // Check parity (count syndrome weight)
      let syndromeWeight = 0;
      for (let i = 0; i < M; i++) {
        const numCols = FT8_SINGLE.LDPC_NUM_ROWS[i];
        let parity = 0;
        for (let j = 0; j < numCols; j++) {
          const varIdx = FT8_SINGLE.LDPC_NM[i][j] - 1;
          if (varIdx >= 0 && varIdx < N) {
            parity ^= decoded[varIdx];
          }
        }
        syndromeWeight += parity;
      }

      if (syndromeWeight === 0) {
        // All parity checks pass - verify CRC
        const info = decoded.slice(0, 91);
        if (FT8ModemSingle.checkCRC14(info)) {
          return info;
        }
        // Parity OK but CRC failed - continue iterating
      }

      // Early termination if syndrome is not improving
      if (iter > 10 && syndromeWeight >= prevSyndrome) {
        // Stalled - no point continuing
        if (syndromeWeight > 20) return null;
      }
      prevSyndrome = syndromeWeight;

      // Update v2c for next iteration
      for (let i = 0; i < M; i++) {
        const numCols = FT8_SINGLE.LDPC_NUM_ROWS[i];
        for (let j = 0; j < numCols; j++) {
          const varIdx = FT8_SINGLE.LDPC_NM[i][j] - 1;
          if (varIdx >= 0 && varIdx < N) {
            v2c[i][j] = totalLLR[varIdx] - c2v[i][j];
          }
        }
      }
    }

    return null; // decoding failed
  }

  // ============================================================
  // SYMBOL MAPPING
  // ============================================================

  /**
   * Full encoding pipeline: text -> 79 channel symbols
   */
  static textToSymbols(text) {
    // 1. Text -> 77 payload bits
    return FT8ModemSingle.payloadToSymbols(FT8ModemSingle.encodeText(text));
  }

  /**
   * Encoding pipeline from 77 payload bits -> 79 channel symbols
   */
  static payloadToSymbols(payload) {
    // 2. CRC-14
    const crc = FT8ModemSingle.computeCRC14(payload);
    const infoBits = new Uint8Array(91);
    infoBits.set(payload);
    for (let i = 0; i < 14; i++) {
      infoBits[77 + i] = (crc >> (13 - i)) & 1;
    }

    // 3. LDPC encode -> 174 bits
    const codeword = FT8ModemSingle.ldpcEncode(infoBits);

    // 4. Gray code mapping: 174 bits -> 58 data symbols (3 bits each)
    const dataSymbols = new Uint8Array(58);
    for (let i = 0; i < 58; i++) {
      const val = (codeword[i * 3] << 2) | (codeword[i * 3 + 1] << 1) | codeword[i * 3 + 2];
      dataSymbols[i] = FT8_SINGLE.GRAY_MAP[val];
    }

    // 5. Insert Costas sync: S7 D29 S7 D29 S7
    const symbols = new Uint8Array(79);
    symbols.set(FT8_SINGLE.COSTAS, 0);       // positions 0-6
    symbols.set(dataSymbols.slice(0, 29), 7);   // positions 7-35
    symbols.set(FT8_SINGLE.COSTAS, 36);      // positions 36-42
    symbols.set(dataSymbols.slice(29, 58), 43); // positions 43-71
    symbols.set(FT8_SINGLE.COSTAS, 72);      // positions 72-78

    return symbols;
  }

  /**
   * Encode long text into extended frame symbols.
   * Structure: [S7 D29 S7 D29]_block1 [S7 D29 S7 D29]_block2 ... S7_terminal
   * Each block shares its terminal Costas with the next block's initial Costas.
   * 79-symbol decode windows overlap by 7 symbols.
   */
  static textToExtendedSymbols(text) {
    const blocks = [];
    for (let i = 0; i < text.length; i += 13) {
      blocks.push(text.substring(i, Math.min(i + 13, text.length)));
    }
    if (blocks.length <= 1) return FT8ModemSingle.textToSymbols(text);

    const allSymbols = [];
    for (let b = 0; b < blocks.length; b++) {
      const sym79 = FT8ModemSingle.textToSymbols(blocks[b]);
      // Each block contributes S7(0-6) D29(7-35) S7(36-42) D29(43-71) = 72 symbols
      // The terminal S7 is shared with the next block's leading S7
      for (let i = 0; i < 72; i++) allSymbols.push(sym79[i]);
    }
    // Terminal Costas S7
    allSymbols.push(...FT8_SINGLE.COSTAS);
    return new Uint8Array(allSymbols);
  }

  /**
   * Estimate TX duration for a given text and mode.
   */
  static estimateDuration(text, mode) {
    if (!text || text.length === 0) return 0;
    if (mode === FT8_SINGLE.MODE_MULTI_FRAME) {
      const n = Math.ceil(text.length / FT8_SINGLE.MULTI_FRAME_USEFUL_CHARS);
      return n * FT8_SINGLE.TX_DURATION + (n - 1) * FT8_SINGLE.MULTI_FRAME_GAP;
    }
    if (mode === FT8_SINGLE.MODE_EXTENDED) {
      const n = Math.ceil(text.length / 13);
      const numSym = n * FT8_SINGLE.EXTENDED_BLOCK_SYMBOLS + 7;
      return numSym * FT8_SINGLE.SYMBOL_PERIOD;
    }
    return FT8_SINGLE.TX_DURATION;
  }

  // ============================================================
  // GFSK MODULATION (Waveform Generation)
  // ============================================================

  /**
   * Gaussian pulse shape: gfsk_pulse(b, t) = 0.5 * (erf(c*b*(t+0.5)) - erf(c*b*(t-0.5)))
   * where c = pi * sqrt(2/ln(2))
   */
  static gfskPulse(bt, t) {
    const c = Math.PI * Math.sqrt(2.0 / Math.LN2); // ~5.336446
    return 0.5 * (FT8ModemSingle._erf(c * bt * (t + 0.5)) - FT8ModemSingle._erf(c * bt * (t - 0.5)));
  }

  /**
   * Approximation of the error function erf(x)
   * Abramowitz and Stegun approximation 7.1.26, max error ~1.5e-7
   */
  static _erf(x) {
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const t = 1.0 / (1.0 + p * x);
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    const t5 = t4 * t;

    const y = 1.0 - (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5) * Math.exp(-x * x);
    return sign * y;
  }

  /**
   * Precompute GFSK pulse array spanning 3 symbol periods.
   * @param {number} nsps - samples per symbol
   * @returns {Float32Array} pulse of length 3*nsps
   */
  _computeGFSKPulse(nsps) {
    const pulseLen = 3 * nsps;
    const pulse = new Float32Array(pulseLen);
    for (let i = 0; i < pulseLen; i++) {
      const tt = (i - 1.5 * nsps) / nsps; // -1.5 to +1.5 symbol periods
      pulse[i] = FT8ModemSingle.gfskPulse(FT8_SINGLE.BT, tt);
    }
    return pulse;
  }

  /**
   * Generate FT8 GFSK waveform from 79 symbols.
   * Faithful to WSJT-X gen_ft8wave.f90
   *
   * @param {Uint8Array} symbols - tone values (0-7), variable length
   * @param {number} sampleRate - audio sample rate (e.g., 48000)
   * @returns {Float32Array} audio waveform
   */
  generateWaveform(symbols, sampleRate) {
    const nsps = Math.round(sampleRate * FT8_SINGLE.SYMBOL_PERIOD); // samples per symbol
    const nsym = symbols.length;

    // Precompute GFSK pulse (3 symbol periods wide)
    const pulse = this._computeGFSKPulse(nsps);
    const pulseLen = pulse.length;

    // Total waveform length: (nsym + 2) * nsps (extra symbols for pulse overlap)
    const totalSamples = (nsym + 2) * nsps;

    // Compute instantaneous frequency deviation (dphi per sample)
    const dphi = new Float64Array(totalSamples);
    const dphiPeak = 2.0 * Math.PI * FT8_SINGLE.HMOD / nsps;

    // Add dummy symbols at start and end (repeat first/last tone)
    const extendedTones = new Uint8Array(nsym + 2);
    extendedTones[0] = symbols[0];
    extendedTones.set(symbols, 1);
    extendedTones[nsym + 1] = symbols[nsym - 1];

    // Accumulate Gaussian-shaped frequency pulses
    for (let j = 0; j < nsym + 2; j++) {
      const tone = extendedTones[j];
      const ib = j * nsps;
      for (let k = 0; k < pulseLen; k++) {
        const idx = ib + k;
        if (idx < totalSamples) {
          dphi[idx] += dphiPeak * pulse[k] * tone;
        }
      }
    }

    // Add carrier frequency
    const dt = 1.0 / sampleRate;
    const carrierDphi = 2.0 * Math.PI * this.baseFreq * dt;
    for (let i = 0; i < totalSamples; i++) {
      dphi[i] += carrierDphi;
    }

    // Phase integration and waveform synthesis
    const nwave = nsym * nsps;
    const wave = new Float32Array(nwave);
    let phi = 0.0;

    for (let i = 0; i < nwave; i++) {
      wave[i] = Math.sin(phi) * this.volume;
      phi += dphi[nsps + i]; // offset by nsps to skip dummy symbol
      // Keep phase in [0, 2*PI) to avoid precision loss
      if (phi > 2.0 * Math.PI) phi -= 2.0 * Math.PI;
      if (phi < 0) phi += 2.0 * Math.PI;
    }

    // Raised-cosine envelope ramp (fade in/out)
    const nramp = Math.round(nsps / 8);
    for (let i = 0; i < nramp; i++) {
      const env = 0.5 * (1.0 - Math.cos(Math.PI * i / nramp));
      wave[i] *= env;
      wave[nwave - 1 - i] *= env;
    }

    return wave;
  }

  // ============================================================
  // TRANSMISSION
  // ============================================================

  /**
   * Cancel current transmission. Stops audio and releases PTT.
   */
  async cancelTransmit() {
    if (!this.transmitting) return;
    this._txAborted = true;
    if (this._txSource) {
      try { this._txSource.stop(); } catch (e) { /* already stopped */ }
    }
    // PTT off and state reset happen in the onended handler
  }

  /** Internal: play a waveform and return a promise. Supports cancel. */
  async _playWaveform(waveform, ctx) {
    const buffer = ctx.createBuffer(1, waveform.length, ctx.sampleRate);
    buffer.getChannelData(0).set(waveform);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Tonalite VOX active : FT8 sur le canal gauche seul
    if (this._vox) source.connect(this._vox.merger, 0, 0);
    else source.connect(ctx.destination);
    this._txSource = source;

    return new Promise((resolve) => {
      source.onended = () => {
        this._txSource = null;
        resolve();
      };
      source.start();
    });
  }

  /** Internal: end transmission (PTT off, state reset). */
  async _endTransmit() {
    this._voxStop();
    await this._pttOff();
    // Le micro entend encore la fin de l'emission (latence de sortie) : on
    // prolonge le silence du ring buffer pour ne jamais se decoder soi-meme.
    this._muteUntil = performance.now() + FT8_SINGLE.TX_MUTE_TAIL_MS;
    this.transmitting = false;
    this._txAborted = false;
    if (this.onStatusChange) {
      this.onStatusChange(this.listening ? 'listening' : 'idle');
    }
  }

  /**
   * Transmit one or more symbol sequences back to back under one PTT.
   * @param {Uint8Array[]} symbolList
   * @param {{gap?: number, onProgress?: function(number, number)}} opts
   * @returns {Promise<{aborted: boolean}>}
   */
  async transmitSymbols(symbolList, opts = {}) {
    if (this.transmitting) throw new Error('Emission deja en cours');
    this.transmitting = true;
    this._txAborted = false;
    if (this.onStatusChange) this.onStatusChange('transmitting');

    const ctx = this._ensureAudioContext();
    const gap = opts.gap !== undefined ? opts.gap : FT8_SINGLE.MULTI_FRAME_GAP;
    let aborted = false;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
      await this._pttOn();
      if (this.voxTone) this._voxStart(ctx);
      const keyed = !!(this.serialPort || this._vox);
      if (keyed && this.pttLeadMs > 0) await sleep(this.pttLeadMs);
      for (let i = 0; i < symbolList.length; i++) {
        if (this._txAborted) break;
        if (opts.onProgress) opts.onProgress(i + 1, symbolList.length);
        const waveform = this.generateWaveform(symbolList[i], ctx.sampleRate);
        await this._playWaveform(waveform, ctx);
        if (!this._txAborted && i < symbolList.length - 1) {
          await new Promise(r => setTimeout(r, gap * 1000));
        }
      }
      // Annulation : PTT relache tout de suite, sans maintien
      if (keyed && this.pttTailMs > 0 && !this._txAborted) await sleep(this.pttTailMs);
    } finally {
      aborted = this._txAborted;
      await this._endTransmit();
    }
    return { aborted };
  }

  /**
   * Transmit text as FT8 GFSK audio.
   */
  transmit(text) {
    return this.transmitSymbols([FT8ModemSingle.textToSymbols(text)]);
  }

  /**
   * Transmit long text as a single extended frame (Mode 2).
   */
  transmitExtended(text) {
    return this.transmitSymbols([FT8ModemSingle.textToExtendedSymbols(text)]);
  }

  // ============================================================
  // RECEPTION / DEMODULATION
  // ============================================================

  /**
   * Start listening on the microphone.
   * Captures raw audio samples into a ring buffer and runs
   * periodic FT8 frame detection with proper FFT-based decoding.
   */
  async startListening() {
    if (this.listening) return;

    const ctx = this._ensureAudioContext();
    const sampleRate = ctx.sampleRate;
    this._nsps = Math.round(sampleRate * FT8_SINGLE.SYMBOL_PERIOD);

    // Ring buffer: sized for extended frames (up to 10 blocks * 72 sym * 0.16s = 115s + margin)
    const maxDuration = 15 + FT8_SINGLE.EXTENDED_MAX_BLOCKS * FT8_SINGLE.EXTENDED_BLOCK_SYMBOLS * FT8_SINGLE.SYMBOL_PERIOD;
    const bufferLen = Math.round(sampleRate * maxDuration);
    this._ringBuffer = new Float32Array(bufferLen);
    this._ringWritePos = 0;
    this._ringBufferLen = bufferLen;
    this._sampleRate = sampleRate;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 },
      }
    });

    const source = ctx.createMediaStreamSource(this.mediaStream);

    // Also keep an analyser for the spectrum visualization
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);

    // ScriptProcessorNode to capture raw samples into the ring buffer
    // (AudioWorklet would be better but ScriptProcessor is simpler and widely supported)
    const bufSize = 4096;
    this._scriptNode = ctx.createScriptProcessor(bufSize, 1, 1);
    this._scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // Pendant notre propre emission, le micro entend le haut-parleur : on
      // ecrit du silence pour ne pas decoder nos trames (ni nos accuses).
      const mute = this.transmitting || performance.now() < this._muteUntil;
      for (let i = 0; i < input.length; i++) {
        this._ringBuffer[this._ringWritePos] = mute ? 0 : input[i];
        this._ringWritePos = (this._ringWritePos + 1) % this._ringBufferLen;
      }
      this._absWritten += input.length;
      // Pass through silence (required for ScriptProcessor to work)
      e.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(this._scriptNode);
    this._scriptNode.connect(ctx.destination);

    this.listening = true;
    this._resetRxState();
    if (this.onStatusChange) this.onStatusChange('listening');

    this._startDecoding();
  }

  /**
   * Stop listening.
   */
  stopListening() {
    this.listening = false;
    if (this._decodeTimer) {
      clearInterval(this._decodeTimer);
      this._decodeTimer = null;
    }
    if (this._spectrumRAF) {
      cancelAnimationFrame(this._spectrumRAF);
      this._spectrumRAF = null;
    }
    if (this._scriptNode) {
      this._scriptNode.disconnect();
      this._scriptNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this._ringBuffer = null;
    if (this.onStatusChange) this.onStatusChange('idle');
  }

  /**
   * Main decode loop. Runs every ~2 seconds.
   * Extracts audio from the ring buffer and searches for FT8 frames.
   */
  _startDecoding() {
    const sampleRate = this._sampleRate;

    // Precompute windows:
    // 1. Rectangular with cosine taper (5%) for tone detection — preserves
    //    orthogonality between tones while reducing GFSK transition artifacts
    // 2. Hann window for spectrum visualization only
    const nsps = this._nsps;
    const taperLen = Math.round(nsps * 0.05);
    this._toneWindow = new Float32Array(nsps);
    for (let i = 0; i < nsps; i++) this._toneWindow[i] = 1.0;
    for (let i = 0; i < taperLen; i++) {
      const env = 0.5 * (1.0 - Math.cos(Math.PI * i / taperLen));
      this._toneWindow[i] = env;
      this._toneWindow[nsps - 1 - i] = env;
    }

    this._hannWindow = new Float32Array(nsps);
    for (let i = 0; i < nsps; i++) {
      this._hannWindow[i] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / nsps));
    }

    // Spectrum visualization update (~15 fps via rAF frame skipping)
    this._spectrumFrameCount = 0;
    const spectrumLoop = () => {
      if (!this.listening || !this.analyser) return;
      this._spectrumFrameCount++;
      if (this._spectrumFrameCount % 4 === 0 && this.onSpectrumData) {
        const freqData = new Float32Array(this.analyser.frequencyBinCount);
        this.analyser.getFloatFrequencyData(freqData);
        this.onSpectrumData(freqData, sampleRate, this.analyser.fftSize);
      }
      this._spectrumRAF = requestAnimationFrame(spectrumLoop);
    };
    this._spectrumRAF = requestAnimationFrame(spectrumLoop);

    // Decode attempt every 2 seconds (async to avoid blocking UI)
    this._decoding = false;
    this._decodeTimer = setInterval(() => {
      if (!this.listening || this.transmitting || !this._ringBuffer || this._decoding) return;
      this._attemptDecodeAsync();
    }, 2000);
  }

  /**
   * Extract audio from ring buffer and attempt FT8 decode.
   * Two-pass approach for real-time performance:
   *   Pass 1: Goertzel precomputation of power spectrogram (fast, ~30ms)
   *   Pass 2: Coarse Costas search on precomputed matrix (instant, lookups)
   *   Pass 3: Fine sub-symbol refinement with Goertzel (on top 2 candidates)
   */

  /** Yield to browser to keep UI responsive */
  _yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async _attemptDecodeAsync() {
    this._decoding = true;
    try {
      await this._attemptDecode();
    } catch (e) {
      console.error('[FT8 RX] decode error:', e);
    } finally {
      this._decoding = false;
    }
  }

  /**
   * Goertzel: compute power of 8 tones in a single pass over audio window.
   * No trig in the inner loop — only multiply-add.
   * @returns {Float64Array} power[8]
   */
  _goertzel8(audio, sampleOff, nsps, coeffs) {
    const win = this._toneWindow;
    let s1_0 = 0, s2_0 = 0, s1_1 = 0, s2_1 = 0;
    let s1_2 = 0, s2_2 = 0, s1_3 = 0, s2_3 = 0;
    let s1_4 = 0, s2_4 = 0, s1_5 = 0, s2_5 = 0;
    let s1_6 = 0, s2_6 = 0, s1_7 = 0, s2_7 = 0;
    const c0 = coeffs[0], c1 = coeffs[1], c2 = coeffs[2], c3 = coeffs[3];
    const c4 = coeffs[4], c5 = coeffs[5], c6 = coeffs[6], c7 = coeffs[7];

    for (let n = 0; n < nsps; n++) {
      const x = audio[sampleOff + n] * win[n];
      let s0;
      s0 = x + c0 * s1_0 - s2_0; s2_0 = s1_0; s1_0 = s0;
      s0 = x + c1 * s1_1 - s2_1; s2_1 = s1_1; s1_1 = s0;
      s0 = x + c2 * s1_2 - s2_2; s2_2 = s1_2; s1_2 = s0;
      s0 = x + c3 * s1_3 - s2_3; s2_3 = s1_3; s1_3 = s0;
      s0 = x + c4 * s1_4 - s2_4; s2_4 = s1_4; s1_4 = s0;
      s0 = x + c5 * s1_5 - s2_5; s2_5 = s1_5; s1_5 = s0;
      s0 = x + c6 * s1_6 - s2_6; s2_6 = s1_6; s1_6 = s0;
      s0 = x + c7 * s1_7 - s2_7; s2_7 = s1_7; s1_7 = s0;
    }

    const p = new Float64Array(8);
    p[0] = s1_0 * s1_0 + s2_0 * s2_0 - c0 * s1_0 * s2_0;
    p[1] = s1_1 * s1_1 + s2_1 * s2_1 - c1 * s1_1 * s2_1;
    p[2] = s1_2 * s1_2 + s2_2 * s2_2 - c2 * s1_2 * s2_2;
    p[3] = s1_3 * s1_3 + s2_3 * s2_3 - c3 * s1_3 * s2_3;
    p[4] = s1_4 * s1_4 + s2_4 * s2_4 - c4 * s1_4 * s2_4;
    p[5] = s1_5 * s1_5 + s2_5 * s2_5 - c5 * s1_5 * s2_5;
    p[6] = s1_6 * s1_6 + s2_6 * s2_6 - c6 * s1_6 * s2_6;
    p[7] = s1_7 * s1_7 + s2_7 * s2_7 - c7 * s1_7 * s2_7;
    return p;
  }

  /**
   * Compute Goertzel coefficients for 8 tones at a given base frequency.
   */
  _goertzelCoeffs(freq0, sampleRate, nsps) {
    const twoPi = 2.0 * Math.PI;
    const coeffs = new Float64Array(8);
    for (let t = 0; t < 8; t++) {
      const k = (freq0 + t * FT8_SINGLE.TONE_SPACING) * nsps / sampleRate;
      coeffs[t] = 2.0 * Math.cos(twoPi * k / nsps);
    }
    return coeffs;
  }

  /**
   * Costas sync score using Goertzel (fast, no trig in inner loop).
   */
  _costasScoreGoertzel(audio, sampleRate, nsps, sampleOff, freq0) {
    const coeffs = this._goertzelCoeffs(freq0, sampleRate, nsps);
    const syncPositions = [0, 36, 72];
    let score = 0;

    for (const pos of syncPositions) {
      for (let i = 0; i < 7; i++) {
        const symOff = sampleOff + (pos + i) * nsps;
        if (symOff + nsps > audio.length) return -Infinity;

        const p = this._goertzel8(audio, symOff, nsps, coeffs);
        const expected = FT8_SINGLE.COSTAS[i];
        const sigP = p[expected];
        let noiseP = 0;
        for (let t = 0; t < 8; t++) {
          if (t !== expected) noiseP += p[t];
        }
        const meanNoise = noiseP / 7;
        if (meanNoise > 0) {
          score += Math.log(sigP / meanNoise + 1e-10);
        } else if (sigP > 0) {
          score += 10;
        }
      }
    }
    return score;
  }

  async _attemptDecode() {
    const sampleRate = this._sampleRate;
    const nsps = this._nsps;
    const t0 = performance.now();

    // Extract audio from ring buffer (enough for extended frames)
    const maxExtract = 15 + FT8_SINGLE.EXTENDED_MAX_BLOCKS * FT8_SINGLE.EXTENDED_BLOCK_SYMBOLS * FT8_SINGLE.SYMBOL_PERIOD;
    const extractLen = Math.min(Math.round(sampleRate * maxExtract), this._ringBufferLen);
    const audio = new Float32Array(extractLen);
    // Absolute sample index of audio[0]: lets us recognise a frame across passes
    const absStart = this._absWritten - extractLen;
    let readPos = (this._ringWritePos - extractLen + this._ringBufferLen) % this._ringBufferLen;
    for (let i = 0; i < extractLen; i++) {
      audio[i] = this._ringBuffer[(readPos + i) % this._ringBufferLen];
    }

    // Energy check
    let energy = 0;
    for (let i = 0; i < audio.length; i++) energy += audio[i] * audio[i];
    const rms = Math.sqrt(energy / audio.length);
    if (energy / audio.length < 1e-8) return; // silence

    // ================================================================
    // PASS 1: Precompute Goertzel power at symbol-aligned positions
    // ================================================================
    // Tone spacing = 6.25 Hz = 1 bin. Search ±3 bins = ±18.75 Hz.
    // Total bins: 8 tones + 6 margin = 14 bins.
    const binWidth = sampleRate / nsps; // 6.25 Hz
    const searchBins = 3; // ±3 bins = ±18.75 Hz
    const numBins = 8 + 2 * searchBins; // 14
    const k0 = this.baseFreq / binWidth - searchBins; // lowest bin

    // Precompute Goertzel coefficients for all 14 bins
    const twoPi = 2.0 * Math.PI;
    const allCoeffs = new Float64Array(numBins);
    for (let b = 0; b < numBins; b++) {
      allCoeffs[b] = 2.0 * Math.cos(twoPi * (k0 + b) / nsps);
    }

    const numPos = Math.floor(audio.length / nsps);
    // Flat array: power[pos * numBins + bin]
    const power = new Float64Array(numPos * numBins);
    const win = this._toneWindow;

    for (let pos = 0; pos < numPos; pos++) {
      const off = pos * nsps;
      if (off + nsps > audio.length) break;

      for (let b = 0; b < numBins; b++) {
        const coeff = allCoeffs[b];
        let s1 = 0, s2 = 0;
        for (let n = 0; n < nsps; n++) {
          const s0 = audio[off + n] * win[n] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        power[pos * numBins + b] = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      }

      if (pos % 12 === 0) await this._yieldToBrowser();
    }

    const t1 = performance.now();

    // Frames already decoded (by absolute position) are excluded from the
    // search: an old frame is never emitted twice, never starves a new one,
    // and the same frame repeated later (ARQ) is a new position, so decoded.
    const frameLen = FT8_SINGLE.NUM_SYMBOLS * nsps;
    this._pruneSpans(absStart);
    const covered = (off) => this._isCovered(absStart + off + frameLen / 2);

    // ================================================================
    // PASS 2: Coarse Costas search (pure lookups on power matrix)
    // ================================================================
    const maxStartPos = numPos - FT8_SINGLE.NUM_SYMBOLS;
    if (maxStartPos < 1) return;

    const syncPositions = [0, 36, 72];
    const coarseAll = [];

    // Test each frequency shift (in whole bins = 6.25 Hz steps)
    for (let binShift = -searchBins; binShift <= searchBins; binShift++) {
      const toneBase = searchBins + binShift; // first tone index in power array

      for (let sp = 0; sp <= maxStartPos; sp++) {
        let score = 0;

        for (let si = 0; si < 3; si++) {
          const syncStart = syncPositions[si];
          for (let i = 0; i < 7; i++) {
            const base = (sp + syncStart + i) * numBins;
            const expected = FT8_SINGLE.COSTAS[i];
            const sigP = power[base + toneBase + expected];
            let noiseP = 0;
            for (let t = 0; t < 8; t++) {
              if (t !== expected) noiseP += power[base + toneBase + t];
            }
            const meanNoise = noiseP / 7;
            if (meanNoise > 0) {
              score += Math.log(sigP / meanNoise + 1e-10);
            } else if (sigP > 0) {
              score += 10;
            }
          }
        }

        if (score > 4.0 && !covered(sp * nsps)) {
          const fHz = binShift * binWidth;
          coarseAll.push({ sampleOff: sp * nsps, sp, fHz, freq0: this.baseFreq + fHz, score });
        }
      }
    }

    // Keep the best candidate of each distinct time slot (non-maximum
    // suppression), so several frames present in the buffer are all tried.
    coarseAll.sort((a, b) => b.score - a.score);
    const coarseCandidates = [];
    for (const c of coarseAll) {
      if (coarseCandidates.length >= FT8_SINGLE.RX_MAX_CANDIDATES) break;
      if (coarseCandidates.every(o => Math.abs(o.sp - c.sp) >= FT8_SINGLE.RX_MIN_CANDIDATE_SPACING)) {
        coarseCandidates.push(c);
      }
    }

    const t2 = performance.now();

    if (coarseCandidates.length === 0) {
      console.log('[FT8 RX] no candidates (' + (t1 - t0 | 0) + 'ms precompute, ' + (t2 - t1 | 0) + 'ms search, RMS=' + rms.toFixed(4) + ')');
      return;
    }
    console.log('[FT8 RX] ' + coarseCandidates.length + ' coarse (best=' + coarseCandidates[0].score.toFixed(0) + ' fHz=' + coarseCandidates[0].fHz.toFixed(0) + ') ' + (t2 - t0 | 0) + 'ms');

    await this._yieldToBrowser();

    // ================================================================
    // PASS 3 + DECODE: fine sub-symbol refinement, then LDPC, per candidate
    // ================================================================
    const fineTimeStep = Math.max(1, Math.round(nsps / 4));
    const fineFreqStep = 1.0; // Hz
    const fineTimeRange = nsps;
    const fineFreqRange = binWidth / 2 + 1; // ±4.125 Hz
    const NUM_FINE = 2;
    const failures = [];

    for (const coarse of coarseCandidates) {
      // A previous candidate of this pass (e.g. an extended frame) may cover it
      if (covered(coarse.sampleOff)) continue;

      const fineCandidates = [];
      const tMin = Math.max(0, coarse.sampleOff - fineTimeRange);
      const tMax = Math.min(audio.length - frameLen, coarse.sampleOff + fineTimeRange);

      const keep = (sOff, fHz, score) => {
        const entry = { sampleOff: sOff, fHz, freq0: this.baseFreq + fHz, score };
        if (fineCandidates.length < NUM_FINE) {
          fineCandidates.push(entry);
        } else if (score > fineCandidates[NUM_FINE - 1].score) {
          fineCandidates[NUM_FINE - 1] = entry;
        } else {
          return;
        }
        fineCandidates.sort((a, b) => b.score - a.score);
      };

      // Separable search (frequency at the coarse time, then time at the best
      // frequency): 18 Costas evaluations instead of 81, several candidates
      // per pass stay affordable on a phone.
      let bestF = coarse.fHz, bestFScore = -Infinity;
      for (let fHz = coarse.fHz - fineFreqRange; fHz <= coarse.fHz + fineFreqRange; fHz += fineFreqStep) {
        const score = this._costasScoreGoertzel(audio, sampleRate, nsps, coarse.sampleOff, this.baseFreq + fHz);
        if (score > bestFScore) { bestFScore = score; bestF = fHz; }
      }
      for (let sOff = tMin; sOff <= tMax; sOff += fineTimeStep) {
        keep(sOff, bestF, this._costasScoreGoertzel(audio, sampleRate, nsps, sOff, this.baseFreq + bestF));
      }
      await this._yieldToBrowser();

      let decoded = false;
      for (const cand of fineCandidates) {
        const refinedFreq0 = this._refineFrequencyGoertzel(
          audio, sampleRate, nsps, cand.sampleOff, cand.freq0
        );
        const payload = this._decodeWindow(audio, sampleRate, nsps, cand.sampleOff, refinedFreq0);
        if (!payload) continue;

        const text = FT8ModemSingle.decodeText(payload);
        const telemetry = text === null ? FT8ModemSingle.decodeTelemetry(payload) : null;
        if (text === null && telemetry === null) continue; // other FT8 message types

        let spanStart = cand.sampleOff;
        let spanEnd = cand.sampleOff + frameLen;
        let frame = { text, telemetry, ext: false, blocks: null, score: cand.score };

        if (text !== null) {
          const ext = this._tryExtendedDecode(
            audio, sampleRate, nsps, cand.sampleOff, refinedFreq0, text, cand.score
          );
          if (ext) {
            spanStart = ext.firstOff;
            spanEnd = ext.lastOff + frameLen;
            frame = { text: ext.text, telemetry: null, ext: true, blocks: ext.blocks, score: cand.score };
          }
        }

        // Text frames: does the signal go on after the frame? The first block
        // of an extended message decodes on its own before the next block is
        // complete; the receiver must not answer while the sender still talks.
        if (text !== null) {
          const cont = this._signalContinues(audio, sampleRate, nsps, spanEnd - frameLen, refinedFreq0);
          if (cont === null) break; // tail not captured yet: retry next pass
          frame.continues = cont;
        } else {
          frame.continues = false;
        }

        frame.absPos = absStart + spanStart;
        frame.absEnd = absStart + spanEnd;
        frame.sampleRate = sampleRate;
        this._decodedSpans.push({ start: frame.absPos, end: frame.absEnd });

        const elapsed = performance.now() - t0;
        console.log('[FT8 RX] ' + (frame.ext ? 'EXTENDED (' + frame.blocks.length + ' blocs)' : text !== null ? 'TEXT' : 'TELEMETRY')
          + ': ' + (text !== null ? '"' + frame.text + '"' : telemetry.toString(16)) + ' in ' + (elapsed | 0) + 'ms');
        if (this.onFrame) this.onFrame(frame);
        decoded = true;
        break;
      }

      if (!decoded && fineCandidates.length > 0) failures.push(fineCandidates[0]);
    }

    // Strong sync but no valid codeword: a frame was there and was lost.
    // Checked after the whole pass (a misaligned window over a frame decoded
    // later in the pass is covered by then), reported once, only once it is
    // in the past, and only if the signal has stopped after it: a window
    // shifted by 36 symbols over a frame still being received syncs strongly
    // too, and answering it would talk over the sender.
    for (const best of failures) {
      const absPos = absStart + best.sampleOff;
      const settled = absPos + frameLen <= this._absWritten - FT8_SINGLE.RX_UNDECODED_SETTLE * sampleRate;
      if (best.score >= FT8_SINGLE.RX_UNDECODED_MIN_SCORE && settled && !covered(best.sampleOff)
          && !this._reportedUndecoded.some(p => Math.abs(p - absPos) < frameLen / 2)
          && this._signalContinues(audio, sampleRate, nsps, best.sampleOff, best.freq0) === false) {
        this._reportedUndecoded.push(absPos);
        console.log('[FT8 RX] undecoded strong frame (score=' + best.score.toFixed(0) + ')');
        if (this.onUndecoded) this.onUndecoded({ absPos, score: best.score, sampleRate });
      }
    }
  }

  /** Magnitudes -> LLR -> LDPC for one 79-symbol window: 77 payload bits or null. */
  _decodeWindow(audio, sampleRate, nsps, sampleOff, freq0) {
    const mag = this._computeMagnitudesGoertzel(audio, sampleRate, nsps, sampleOff, freq0);
    if (!mag) return null;
    const llr = this._extractLLRNormalized(mag);
    if (!llr) return null;
    const info91 = FT8ModemSingle.ldpcDecode(llr, 50);
    if (!info91) return null;
    // All-zero codeword: valid for LDPC and for CRC-14 alike, but it is what
    // silence (e.g. our muted buffer during TX) decodes to. Never a real frame.
    if (!info91.some(b => b)) return null;
    return info91.slice(0, 77);
  }

  /**
   * Mean tone contrast (strongest of the 8 tones / mean of the 7 others) over
   * nsym symbols. ~3.9 on noise (4 symbols), much higher on an FT8 signal.
   */
  _toneContrast(audio, sampleRate, nsps, sampleOff, freq0, symbolIdx) {
    const coeffs = this._goertzelCoeffs(freq0, sampleRate, nsps);
    let sum = 0;
    for (const s of symbolIdx) {
      const p = this._goertzel8(audio, sampleOff + s * nsps, nsps, coeffs);
      let max = 0, total = 0;
      for (let t = 0; t < 8; t++) { total += p[t]; if (p[t] > max) max = p[t]; }
      const rest = (total - max) / 7;
      sum += rest > 0 ? max / rest : 100;
    }
    return sum / symbolIdx.length;
  }

  /**
   * Is the signal still present right after the 79-symbol window at frameOff?
   * @returns {boolean|null} null when the tail is not in the buffer yet
   */
  _signalContinues(audio, sampleRate, nsps, frameOff, freq0) {
    const tailOff = frameOff + FT8_SINGLE.NUM_SYMBOLS * nsps;
    const n = FT8_SINGLE.RX_TAIL_SYMBOLS;
    if (tailOff + n * nsps > audio.length) return null;
    const dataIdx = [];
    for (let s = 7; s < 36; s++) dataIdx.push(s);
    for (let s = 43; s < 72; s++) dataIdx.push(s);
    const inFrame = this._toneContrast(audio, sampleRate, nsps, frameOff, freq0, dataIdx);
    const tailIdx = [];
    for (let s = 0; s < n; s++) tailIdx.push(s);
    const tail = this._toneContrast(audio, sampleRate, nsps, tailOff, freq0, tailIdx);
    // Geometric mean between the noise floor and the frame's own contrast
    return tail > Math.sqrt(Math.max(inFrame, FT8_SINGLE.RX_NOISE_CONTRAST) * FT8_SINGLE.RX_NOISE_CONTRAST);
  }

  _resetRxState() {
    this._absWritten = 0;
    this._decodedSpans = [];
    this._reportedUndecoded = [];
  }

  /** Forget spans that have left the ring buffer. */
  _pruneSpans(absStart) {
    this._decodedSpans = this._decodedSpans.filter(sp => sp.end > absStart);
    this._reportedUndecoded = this._reportedUndecoded.filter(p => p > absStart - this._ringBufferLen);
  }

  _isCovered(absSample) {
    return this._decodedSpans.some(sp => absSample >= sp.start && absSample < sp.end);
  }

  /**
   * Try to decode additional LDPC blocks after a successful standard decode.
   * Extended frame structure: [S7 D29 S7 D29]_72sym per block, terminal S7.
   * Each 79-symbol window overlaps with the next by 7 (shared Costas).
   */
  _tryExtendedDecode(audio, sampleRate, nsps, sampleOff, freq0, firstText, firstScore) {
    const texts = [firstText];
    const blockStep = FT8_SINGLE.EXTENDED_BLOCK_SYMBOLS * nsps; // 72 symbols
    // Require at least 40% of the first block's Costas score to accept a continuation
    const minScore = Math.max(20, (firstScore || 50) * 0.4);

    // Decode the 79-symbol window at a block boundary, or null if absent/invalid
    const decodeBlockAt = (blockOff) => {
      if (blockOff < 0 || blockOff + FT8_SINGLE.NUM_SYMBOLS * nsps > audio.length) return null;
      const score = this._costasScoreGoertzel(audio, sampleRate, nsps, blockOff, freq0);
      if (score < minScore) return null; // No valid block here
      const payload = this._decodeWindow(audio, sampleRate, nsps, blockOff, freq0);
      return payload ? FT8ModemSingle.decodeText(payload) : null;
    };

    // The best Costas candidate may be any block of the frame, not only the
    // first: search backward for preceding blocks, then forward.
    let firstOff = sampleOff;
    let lastOff = sampleOff;
    while (texts.length < FT8_SINGLE.EXTENDED_MAX_BLOCKS) {
      const text = decodeBlockAt(firstOff - blockStep);
      if (text === null) break;
      texts.unshift(text);
      firstOff -= blockStep;
    }
    while (texts.length < FT8_SINGLE.EXTENDED_MAX_BLOCKS) {
      const text = decodeBlockAt(lastOff + blockStep);
      if (text === null) break;
      texts.push(text);
      lastOff += blockStep;
    }

    if (texts.length > 1) {
      // Every block but the last carries exactly 13 characters (see
      // textToExtendedSymbols), so trailing spaces of inner blocks are content.
      const joined = texts.slice(0, -1).map(t => t.padEnd(13, ' ')).join('') + texts[texts.length - 1];
      return {
        text: joined.trimEnd(),
        blocks: texts.map(t => t.trimEnd()),
        firstOff,
        lastOff
      };
    }
    return null; // Single block, not an extended frame
  }

  // ============================================================
  // GOERTZEL-BASED DEMODULATION HELPERS
  // ============================================================

  /**
   * Refine frequency using parabolic interpolation on Costas score (Goertzel).
   */
  _refineFrequencyGoertzel(audio, sampleRate, nsps, sampleOff, freq0) {
    const delta = 0.5;
    const sL = this._costasScoreGoertzel(audio, sampleRate, nsps, sampleOff, freq0 - delta);
    const sC = this._costasScoreGoertzel(audio, sampleRate, nsps, sampleOff, freq0);
    const sR = this._costasScoreGoertzel(audio, sampleRate, nsps, sampleOff, freq0 + delta);
    const denom = sL - 2 * sC + sR;
    if (Math.abs(denom) < 1e-10) return freq0;
    const offset = 0.5 * (sL - sR) / denom;
    return freq0 + Math.max(-delta, Math.min(delta, offset)) * delta;
  }

  /**
   * Compute magnitude matrix for all 79 symbols using Goertzel.
   * Returns mag[sym][tone] (linear magnitude).
   */
  _computeMagnitudesGoertzel(audio, sampleRate, nsps, sampleOff, freq0) {
    const numSymbols = FT8_SINGLE.NUM_SYMBOLS;
    if (sampleOff + numSymbols * nsps > audio.length) return null;

    const coeffs = this._goertzelCoeffs(freq0, sampleRate, nsps);
    const mag = new Array(numSymbols);

    for (let s = 0; s < numSymbols; s++) {
      const symOff = sampleOff + s * nsps;
      const p = this._goertzel8(audio, symOff, nsps, coeffs);
      const m = new Float32Array(8);
      for (let t = 0; t < 8; t++) m[t] = Math.sqrt(Math.max(0, p[t]));
      mag[s] = m;
    }
    return mag;
  }

  /**
   * Extract LLRs from the 79-symbol magnitude matrix.
   * Uses max-log MAP approach (as in ft8_lib/WSJT-X):
   *   For each bit, LLR = max(log-power where bit=0) - max(log-power where bit=1)
   * This is robust against GFSK spectral spreading because it uses relative
   * power differences rather than absolute noise estimates.
   */
  _extractLLRNormalized(mag) {
    // Compute log-power for all symbols
    const logPower = new Array(79);
    for (let s = 0; s < 79; s++) {
      logPower[s] = new Float32Array(8);
      for (let t = 0; t < 8; t++) {
        logPower[s][t] = Math.log(mag[s][t] * mag[s][t] + 1e-20);
      }
    }

    // Estimate signal quality from Costas sync symbols to scale LLRs
    // Use the ratio of expected tone power to 2nd-best tone power
    const syncPositions = [0, 36, 72];
    let snrSum = 0;
    let snrCount = 0;

    for (const pos of syncPositions) {
      for (let i = 0; i < 7; i++) {
        const lp = logPower[pos + i];
        const expectedTone = FT8_SINGLE.COSTAS[i];
        const sigLP = lp[expectedTone];

        // Find max of non-expected tones
        let maxOther = -Infinity;
        for (let t = 0; t < 8; t++) {
          if (t !== expectedTone && lp[t] > maxOther) maxOther = lp[t];
        }

        snrSum += sigLP - maxOther;
        snrCount++;
      }
    }

    // Average log-domain SNR across sync symbols
    const avgLogSNR = snrCount > 0 ? snrSum / snrCount : 1;
    // LLR scale: normalize so that typical data symbol LLRs are in range ±5-10
    // Higher SNR signals need less scaling to get good LLRs
    const llrScale = Math.max(0.5, Math.min(4.0, 2.5 / Math.max(avgLogSNR, 0.1)));

    // Data symbol positions within 79-symbol frame
    const dataPositions = [];
    for (let i = 7; i <= 35; i++) dataPositions.push(i);
    for (let i = 43; i <= 71; i++) dataPositions.push(i);

    const llr = new Float32Array(174);
    let llrIdx = 0;

    for (let d = 0; d < 58; d++) {
      const lp = logPower[dataPositions[d]];

      // Max-log MAP: for each bit, find the best tone for bit=0 and bit=1
      for (let bit = 0; bit < 3; bit++) {
        let max0 = -Infinity, max1 = -Infinity;

        for (let tone = 0; tone < 8; tone++) {
          const grayVal = FT8_SINGLE.GRAY_UNMAP[tone];
          const bitVal = (grayVal >> (2 - bit)) & 1;

          if (bitVal === 0) {
            if (lp[tone] > max0) max0 = lp[tone];
          } else {
            if (lp[tone] > max1) max1 = lp[tone];
          }
        }

        // LLR = (max log-power where bit=0) - (max log-power where bit=1)
        // Positive = more likely 0
        llr[llrIdx] = (max0 - max1) * llrScale;

        // Clamp to ±15
        llr[llrIdx] = Math.max(-15, Math.min(15, llr[llrIdx]));
        llrIdx++;
      }
    }

    return llr;
  }

  // ============================================================
  // SPECTRUM HELPERS
  // ============================================================

  /**
   * Get tone frequency for display purposes.
   */
  toneFreq(symbol) {
    return this.baseFreq + symbol * FT8_SINGLE.TONE_SPACING;
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  updateSettings(settings) {
    if (settings.baseFreq !== undefined) this.baseFreq = settings.baseFreq;
    if (settings.volume !== undefined) this.volume = settings.volume;
    if (settings.pttSignal !== undefined) this.pttSignal = settings.pttSignal;
    if (settings.pttActiveHigh !== undefined) this.pttActiveHigh = settings.pttActiveHigh;
    if (settings.pttLeadMs !== undefined) this.pttLeadMs = settings.pttLeadMs;
    if (settings.pttTailMs !== undefined) this.pttTailMs = settings.pttTailMs;
    if (settings.voxTone !== undefined) this.voxTone = !!settings.voxTone;
  }

  // ============================================================
  // PTT PAR TONALITE (VOX, canal droit)
  // ============================================================

  /**
   * Demarre la tonalite VOX sur le canal droit, pour toute la duree de
   * l'emission (avance, trames, intervalles, maintien). Sortie mono : la
   * tonalite se melangerait au FT8, on n'emet alors que le FT8_SINGLE.
   */
  _voxStart(ctx) {
    if (this._vox) return;
    if (ctx.destination.maxChannelCount < 2) {
      console.warn('[PTT] Sortie audio mono : tonalite VOX impossible');
      return;
    }
    const merger = ctx.createChannelMerger(2);
    merger.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.frequency.value = FT8_SINGLE.VOX_TONE_HZ;
    const gain = ctx.createGain();
    gain.gain.value = FT8_SINGLE.VOX_TONE_LEVEL;
    osc.connect(gain);
    gain.connect(merger, 0, 1);
    osc.start();
    this._vox = { merger, osc, gain };
    console.log('[PTT] tonalite VOX ON (' + FT8_SINGLE.VOX_TONE_HZ + ' Hz, canal droit)');
  }

  _voxStop() {
    if (!this._vox) return;
    const { merger, osc, gain } = this._vox;
    this._vox = null;
    try { osc.stop(); } catch (e) { /* deja arretee */ }
    osc.disconnect();
    gain.disconnect();
    merger.disconnect();
    console.log('[PTT] tonalite VOX OFF');
  }

  // ============================================================
  // PTT CONTROL (WebSerial RTS/DTR)
  // ============================================================

  async _pttOn() {
    if (!this.serialPort) return;
    try {
      const sig = this.pttSignal === 'DTR' ? 'dataTerminalReady' : 'requestToSend';
      await this.serialPort.setSignals({ [sig]: this.pttActiveHigh });
      console.log('[PTT] ON (' + this.pttSignal + '=' + this.pttActiveHigh + ')');
    } catch (e) {
      console.warn('[PTT] ON failed:', e);
    }
  }

  async _pttOff() {
    if (!this.serialPort) return;
    try {
      const sig = this.pttSignal === 'DTR' ? 'dataTerminalReady' : 'requestToSend';
      await this.serialPort.setSignals({ [sig]: !this.pttActiveHigh });
      console.log('[PTT] OFF');
    } catch (e) {
      console.warn('[PTT] OFF failed:', e);
    }
  }

  destroy() {
    this.stopListening();
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}


// Méthodes attendues par l'application actuelle (absentes de cette version) :
// pas de détection des trames en cours de réception ni de canaux de réseau.
FT8ModemSingle.prototype.channelBusy = function () { return false; };
FT8ModemSingle.prototype.rxActivity = function () { return { onAir: [], decoded: [] }; };
FT8ModemSingle.prototype.setChannels = function () {};
