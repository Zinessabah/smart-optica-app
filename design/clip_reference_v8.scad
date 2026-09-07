// ============================================================
// Clip de référence optométrique — v8 (Corrigé & Soudé)
// ============================================================
// Corrections vs v6/v7 (analyse maillage : 4 coquilles → cible 1) :
//   1. Montant central ramené à y=0 (v6/v7 l'avaient à y=−3.5 →
//      mire 4 flottante à 3.5mm) ; mire 4 sinkée dans le cône.
//   2. Poteau latéral VERTICAL et centré SOUS la mire 3 (v7 l'avait
//      décalé de 2mm en x → jeu 0.5-0.75mm → mire flottante) ;
//      mire 3 sinkée dans le sommet du poteau.
//   3. Bras vers l'ARRIÈRE (−Y, le long de la tempe) — v6/v7
//      partaient vers +Y (côté caméra).
//   4. Pince : canal en C dont la face interne du montant droit est
//      INCLINÉE (rampe de calage) → calage universel 2-6.5mm.
//      (La v7 annonçait 6.5mm mais l'ouverture réelle était
//      gap − lèvre fixe = 3.5mm.)
//   5. sink = 0.8 systématique (leçon v4.1) → fusion volumique.
//   6. marker_pad = disque PLEIN (pas de recess → pas de 2e volume).
//
// Repère : X = largeur (barre), Y = profondeur (+Y = AVANT/caméra,
//          −Y = ARRIÈRE/tempe), Z = hauteur.
// Plan du verre : y = 0 (face avant de la barre).
//   Centres mires faciales : (±50, 0, 3), (0, 0, 3), (30, 0, 17.2)
//   (mire 4 = disque VERTICAL dans le plan XZ des autres mires,
//   montant décalé de 30mm horizontal — plan parallèle aux autres)
//   → coplanaires au plan XZ (plan du verre).
//   Centres mires latérales : (56, −14, 12), (56, −38, 12), (56, −26, 22)
//   (mire 3 = disque VERTICAL dans le plan YZ des autres mires,
//   surélevée de 10mm → non-colinéarité solvePnP profil)
//   → coplanaires au plan YZ (x=56), non colinéaires (solvePnP profil).
// ============================================================

$fn = 48;

// ===== Barre faciale =====
facial_half_span  = 50;   // mm — position des mires faciales (± et 0)
bar_margin        = 8;    // mm — extension de barre au-delà des mires → x0 = 58
bar_thickness     = 4.0;  // mm — profondeur (Y), UNIFIÉE avec les bras (4mm)
bar_height        = 6;    // mm — hauteur (Z)
sink              = 0.8;  // mm — pénétration volumique (fusion 2-manifold)

// ===== Mires faciales (plan XZ, centres y=0) =====
facial_pad_d         = 10;   // mm
facial_pad_thickness = 1.5;  // mm
stem_height          = 12;   // mm — montant central (4e mire hors-axe)
stem_base_d          = 5;
stem_top_d           = 3.5;
stem_flare_h         = 3;

// ===== Pince — canal en C, rampe de calage universelle =====
clamp_len        = 12;   // mm — longueur (Y)
clamp_depth      = 10;   // mm — profondeur (X) — réduit pour encadrer la mire centrale (x=30)
clamp_height     = 10;   // mm — hauteur (Z)
clamp_lip        = 2;    // mm — épaisseur lèvre + montants
clamp_gap_min    = 2;    // mm — largeur du canal en HAUT (fond, côté lèvre haute)
clamp_gap_max    = 6.5;  // mm — largeur du canal en BAS (ouverture, calage 2-6.5mm)

// ===== Bras latéral (vers −Y, le long de la tempe) =====
arm_length     = 40;    // mm — LONGUEUR (conservée, seule dimension différente)
arm_width      = 4;     // mm (X) — même dimension que bar_thickness
arm_thickness  = 6;     // mm (Z) — même dimension que bar_height (6)

// ===== Mires latérales (plan YZ, centres x=56) =====
lateral_pad_d        = 10;   // mm — même diamètre que les mires faciales (Ø10)
lateral_marker_z     = 12;   // mm — hauteur des mires latérales 1-2 (demande Driss)
lateral_start_offset = 8;    // mm — mire 1 depuis l'arrière de la pince
lateral_baseline     = 24;   // mm — écart mire1-mire2 (~25 de main.py)
lateral_post_height  = 10;   // mm — surélévation de la mire 3 (non-colinéarité)
lateral_post_base_d  = 4;
lateral_post_top_d   = 2.5;

// ============================================================
// MODULES
// ============================================================

// Pastille PLEINE (leçon v4.1 : pas de recess → pas de 2e volume CGAL)
module marker_pad(d, h) {
    cylinder(d = d, h = h);
}

// Poteau en tronc de cône évasé à la base (rigidité)
module tapered_post(base_d, top_d, height, flare_d, flare_h) {
    union() {
        hull() {
            cylinder(d = flare_d, h = 0.01);
            translate([0, 0, flare_h])
                cylinder(d = base_d, h = 0.01);
        }
        translate([0, 0, flare_h - 0.15])
            cylinder(d1 = base_d, d2 = top_d, h = height - flare_h + 0.15);
    }
}

// Mire latérale : POTEAU vertical + disque Ø10 au sommet, centré sur x0−2
// (toutes les mires latérales à la même hauteur z, plan YZ coplanaire)
module lateral_marker_post(y_pos, top_z) {
    translate([0, y_pos, -sink])
        cylinder(d1 = lateral_post_base_d, d2 = lateral_post_top_d,
                 h = top_z + sink);
    translate([0, y_pos, top_z])
        rotate([0, 90, 0])
            translate([0, 0, -(facial_pad_thickness / 2)])
                marker_pad(lateral_pad_d, facial_pad_thickness);
}

// ============================================================
// ASSEMBLAGE FACIAL — mires coplanaires au plan du verre (XZ, y=0)
// ============================================================
module facial_assembly() {
    x0 = facial_half_span + bar_margin;   // 58

    // Barre continue, face avant à y=0, de −x0 à +x0
    translate([-x0, -bar_thickness, 0])
        cube([2 * x0, bar_thickness, bar_height]);

    // 3 mires faciales — centres (±50, 0, 3), (0, 0, 3) ; faces à y=0.75
    // sink = −thickness/2 → centre exactement dans le plan du verre (y=0)
    for (x = [-facial_half_span, 0, facial_half_span])
        translate([x, -facial_pad_thickness / 2, bar_height / 2])
            rotate([-90, 0, 0])
                marker_pad(facial_pad_d, facial_pad_thickness);

    // Montant central décalé à x=30 (hors centre, demande Driss 30mm horizontal)
    // + 4e mire coplanaire au sommet, sinkée dans le cône
    translate([30, 0, bar_height - sink])
        tapered_post(stem_base_d, stem_top_d, stem_height,
                     stem_base_d * 1.3, stem_flare_h);
    translate([30, -facial_pad_thickness / 2, bar_height + stem_height - sink])
        rotate([-90, 0, 0])
            marker_pad(facial_pad_d, facial_pad_thickness);

    // Pontet d'appui nasal (appui sur le pont, au centre de la monture)
    translate([-5, -bar_thickness - 3, 0])
        cube([10, 5, 2]);
}

// ============================================================
// PINCE — canal en C, OUVERTURE VERS LE BAS (accrochage monture)
// La monture entre par le bas (canal large 6.5mm) et remonte se
// caler : le canal se rétrécit vers le haut (2mm sous la lèvre
// haute) → la monture d'épaisseur e se cale où largeur = e.
// ============================================================
module hinge_clamp() {
    lip = clamp_lip;
    hgt = clamp_height;
    union() {
        // lèvre HAUTE (fond du canal) : la monture remonte se caler contre elle
        translate([0, 0, hgt - lip])
            cube([clamp_depth, clamp_len, lip]);
        // montant gauche (face interne plane à x = lip)
        cube([lip, clamp_len, hgt]);
        // montant droit en biseau : section (lip+gap_max,0)-(d,0)-(d,hgt)-(lip+gap_min,hgt)
        // → canal 6.5mm en bas (ouverture) → 2mm en haut (calage)
        hull() {
            translate([lip + clamp_gap_max, 0, 0])
                cube([0.01, clamp_len, 0.01]);
            translate([clamp_depth - lip, 0, 0])
                cube([0.01, clamp_len, 0.01]);
            translate([lip + clamp_gap_min, 0, hgt])
                cube([0.01, clamp_len, 0.01]);
            translate([clamp_depth - lip, 0, hgt])
                cube([0.01, clamp_len, 0.01]);
        }
    }
}

// ============================================================
// BRAS LATÉRAL — mires coplanaires au plan YZ (x=58)
// (les pinces d'accrochage sont placées dans l'assemblage final,
// de part et d'autre de la mire centrale faciale)
// ============================================================
module side_arm_right() {
    x0 = facial_half_span + bar_margin;   // 58
    yb = -clamp_len / 2;                  // −6

    // Bras vers l'arrière (−Y) le long de la tempe — MÊMES DIMENSIONS
    // que la barre (4×6, z∈[0,6]), x∈[54,58] : pénètre la barre
    // (y∈[−4,−2] ⊂ barre → fusion volumique directe)
    translate([x0 - arm_width, yb - arm_length - sink, 0])
        cube([arm_width, arm_length + sink + bar_thickness, arm_thickness]);

    // Mires latérales 1 et 2 — poteaux + disques Ø10, centres (56, −14, 12)
    // et (56, −38, 12) : remontées à z=12 (demande Driss)
    translate([x0 - 2, 0, 0])
        lateral_marker_post(yb - lateral_start_offset, lateral_marker_z);
    translate([x0 - 2, 0, 0])
        lateral_marker_post(yb - lateral_start_offset - lateral_baseline,
                            lateral_marker_z);
    // Mire latérale 3 (centrale) : poteau + disque Ø10 SURÉLEVÉS
    // (z=12 + lateral_post_height = 22) → non-colinéarité solvePnP profil
    translate([x0 - 2, 0, 0])
        lateral_marker_post(yb - lateral_start_offset - lateral_baseline / 2,
                            lateral_marker_z + lateral_post_height);
}

// ============================================================
// ASSEMBLAGE FINAL — pièce unique, bilatérale
// ============================================================
union() {
    facial_assembly();
    // Pinces d'accrochage monture, déplacées de 25mm vers l'intérieur,
    // de part et d'autre de la mire faciale centrale (x=30) :
    //   G : x∈[−42,−30]   D : x∈[30,42]  (centres ±36 = ±61 − 25)
    // TOURNÉES de 90° autour de Z : le canal s'étend le long de X (= plan
    // de la monture), la monture se cale par son épaisseur Y.
    // Placées SOUS la barre (z∈[−9.2,0.8]) : canal libre pour la monture.
    // Ouverture vers le bas : la monture entre par le bas, remonte se caler.
    translate([42, -clamp_depth / 2, -clamp_height + sink])
        rotate([0, 0, 90]) hinge_clamp();
    translate([-30, -clamp_depth / 2, -clamp_height + sink])
        rotate([0, 0, 90]) hinge_clamp();
    side_arm_right();
    mirror([1, 0, 0]) side_arm_right();
}
