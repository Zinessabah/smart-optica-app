// ============================================================
// Clip de référence optométrique — v3.1 (imprimable, précision améliorée)
// ============================================================
// Format : OpenSCAD (.scad) — fichier paramétrique, PAS un STL.
// Pour obtenir le fichier imprimable :
//   1. Installer OpenSCAD (gratuit) : openscad.org
//   2. Ouvrir ce fichier
//   3. Design > Render (F6)
//   4. File > Export > Export as STL
// Ligne de commande : openscad -o clip_reference_v3.stl clip_reference_v3.scad
//
// Changements v3.1 (retour Driss) :
//   • 5 PINCES au lieu de 2 : 3 sur la barre faciale (au-dessus des verres
//     et du pont) + 2 en bout de bras latéraux → fixation stable sur la monture
//   • Montant de la 4e mire DÉCALÉ en X (stem_x = -12) pour ne pas boucher
//     la pince centrale (à x=0, au-dessus du pont)
//   • Pinces de barre : canal ouvert vers le bas, lèvres verticales qui
//     pincent le bord supérieur de la monture par flexion
//
// Améliorations v3 (conservées) :
//   • Mires latérales sur la FACE EXTERNE des bras → visibles de profil
//   • Triangle latéral identique des 2 côtés (mirror X seul)
//   • 3e mire latérale portée par montant (v2 : flottait)
//   • Pince en U corrigée, rigidité (barre 8mm + nervures)
//   • Sink systématique → fusion CGAL = pièce unique
//   • Recess traversant la surface (poche ouverte)
//
// À ajuster après mesure réelle :
//   clamp_gap : épaisseur du bord de monture / branche (2.5–4 mm)
// ============================================================

$fn = 64; // 96 pour rendu final, 48 pour preview rapide

// ===== [1] BARRE FACIALE =====
facial_half_span    = 50;   // mm, centre -> mire gauche/droite (50mm = specs)
bar_thickness       = 3;    // mm, épaisseur de la barre
bar_height          = 8;    // mm, hauteur de la barre (rigidité anti-torsion)
bar_margin          = 15;   // mm, dépassement au-delà des mires vers les bras
rib_height          = 3;    // mm, nervures sous la barre (entre les mires)
rib_thickness       = 2;    // mm, épaisseur d'une nervure

// ===== [2] MIRES FACIALES (3 colinéaires + 1 hors-axe) =====
facial_pad_outer_d   = 12;   // mm, diamètre externe (specs réelles)
facial_pad_inner_d   = 10;   // mm, diamètre interne du motif étiquette
facial_pad_thickness = 1.5;  // mm, épaisseur du plot support
label_recess         = 0.15; // mm, renfoncement pour l'étiquette

// ===== [3] 4e MIRE HORS-AXE (anti-colinéarité → solvePnP stable) =====
stem_height           = 15;  // mm, hauteur du montant central
stem_section          = 4;   // mm, section carrée du montant
stem_gusset           = 6;   // mm, taille des goussets de renfort
stem_x                = -12; // mm, décalage X du montant (libère la pince centrale !)

// ===== [4] BRAS LATÉRAUX =====
arm_length            = 55;  // mm, longueur du bras depuis la barre
arm_thickness         = 3;   // mm, épaisseur du bras

// ===== [5] MIRES LATÉRALES (3 non-colinéaires, face EXTERNE) =====
lateral_pad_d         = 6;   // mm, plot support (motif visuel = 4mm)
lateral_baseline      = 35;  // mm, écart mire1-mire2 le long du bras
lateral_offset_h      = 18;  // mm, hauteur du montant de la 3e mire
lateral_stem_section  = 5;   // mm, section carrée du montant latéral
lateral_protrude      = 5;   // mm, dépassement du plot hors de la face externe
lateral_start         = 12;  // mm, distance première mire depuis le début du bras

// ===== [6] PINCE EN U (canal, sans vis) — TYPE UNIQUE facial/latéral =====
clamp_len             = 12;  // mm, longueur du canal
clamp_gap             = 3.2; // mm, — À MESURER — épaisseur bord monture/branche
clamp_lip_thickness   = 1.2; // mm, épaisseur des lèvres flexibles
clamp_lip_height      = 6;   // mm, hauteur des lèvres au-dessus de la base

// ===== [7] PINCES DE BARRE (fixation sur le bord supérieur de la monture) =====
// ⚠️ MÊME TYPE que les pinces latérales : réutilise hinge_clamp(), retourné
// (canal vers le bas). Clamp_gap, lèvres et dimensions IDENTIQUES.
frame_clamp_positions = [-45, 0, 45]; // mm, positions X des pinces sur la barre

// ============================================================
// MODULES
// ============================================================

// Plot support d'étiquette : chanfrein de base (fusionné) + renfoncement
// ⚠️ Le creux traverse la surface supérieure (poche OUVERTE = 1 volume)
module marker_pad(d, h, recess) {
    chamfer = 1.0;
    cylinder(d1 = d + 2 * chamfer, d2 = d, h = chamfer);
    translate([0, 0, chamfer]) {
        difference() {
            cylinder(d = d, h = h);
            if (recess > 0)
                translate([0, 0, h - recess])
                    cylinder(d = d - 0.8, h = recess + 0.02);
        }
    }
}

// Nervures anti-torsion entre les mires faciales
module facial_ribs() {
    for (x = [-facial_half_span / 2, facial_half_span / 2])
        translate([x - rib_thickness / 2, -bar_height / 2, 0])
            cube([rib_thickness, bar_height, rib_height]);
}

// Pince en U — TYPE UNIQUE pour barre et bras
// Canal : 2 lèvres flexibles qui pincent par flexion.
// • En bout de bras : canal ouvert vers le haut (pose sur la branche)
// • Sous la barre : MÊME module retourné (canal ouvert vers le bas,
//   clip sur le bord supérieur de la monture)
module hinge_clamp() {
    w = 2 * clamp_lip_thickness + clamp_gap;
    total_h = arm_thickness + clamp_lip_height;
    translate([0, -w / 2, 0])
        difference() {
            cube([clamp_len, w, total_h]);
            translate([-0.05, clamp_lip_thickness, arm_thickness])
                cube([clamp_len + 0.1, clamp_gap, clamp_lip_height + 0.05]);
        }
}

// Pince de barre = hinge_clamp retourné à 180° (canal vers le bas)
// + sink : la base pleine pénètre dans la barre → fusion CGAL
module frame_clamp() {
    // Retourne le module : la base pleine (arm_thickness) se retrouve en haut,
    // le canal (clamp_lip_height) vers le bas.
    // translate z = +0.8 : la base (épaisseur arm_thickness=3) pénètre de 0.8
    // dans la barre (0..3) → intersection volumique.
    translate([0, 0, 0.8])
        rotate([180, 0, 0])
            hinge_clamp();
}

module facial_assembly() {
    union() {
        // barre continue
        translate([-(facial_half_span + bar_margin), -bar_height / 2, 0])
            cube([2 * (facial_half_span + bar_margin), bar_height, bar_thickness]);

        // nervures de rigidité
        facial_ribs();

        // 3 pinces de barre (fixation monture) — sink dans la barre
        for (x = frame_clamp_positions)
            translate([x, 0, 0])
                frame_clamp();

        // 3 mires colinéaires (gauche, centre, droite) — sink 0.6
        for (x = [-facial_half_span, 0, facial_half_span])
            translate([x, 0, bar_thickness - 0.6])
                marker_pad(facial_pad_outer_d, facial_pad_thickness, label_recess);

        // montant de la 4e mire (décalé en X → ne bouche pas la pince centrale)
        translate([stem_x - stem_section / 2, -stem_section / 2, -0.8])
            union() {
                cube([stem_section, stem_section, stem_height + 0.8]);
                for (a = [0, 90, 180, 270])
                    rotate([0, 0, a])
                        translate([0, -stem_section / 2, 0])
                            linear_extrude(height = stem_gusset * 0.6)
                                polygon([[0, 0], [stem_gusset, 0], [0, stem_gusset]]);
            }
        // 4e mire au sommet du montant
        translate([stem_x, 0, stem_height - 0.6])
            marker_pad(facial_pad_outer_d, facial_pad_thickness, label_recess);
    }
}

// Plot latéral : axe Y (perpendiculaire au bras), étiquette vers l'extérieur
module lateral_plot(sink = 0.6) {
    translate([0, -sink, 0])
        rotate([90, 0, 0])
            marker_pad(lateral_pad_d, lateral_protrude, label_recess * 0.6);
}

module side_arm() {
    x0 = facial_half_span + bar_margin;
    w = 2 * clamp_lip_thickness + clamp_gap;

    // bras (pénètre dans la barre : sink 0.8)
    translate([x0 - 0.8, -w / 2, 0])
        cube([arm_length + 0.8, w, arm_thickness]);

    // pince en bout de bras
    translate([x0 + arm_length - clamp_len, 0, 0])
        hinge_clamp();

    // 2 mires latérales dans le plan du bras
    translate([x0 + lateral_start, 0, arm_thickness]) {
        translate([0, w / 2, 0])
            lateral_plot();
        translate([lateral_baseline, w / 2, 0])
            lateral_plot();
    }

    // montant de la 3e mire (part du fond du bras → fusionne)
    translate([x0 + lateral_start + lateral_baseline / 2 - lateral_stem_section / 2,
               w / 2 - lateral_stem_section, 0]) {
        cube([lateral_stem_section, lateral_stem_section, arm_thickness + lateral_offset_h]);
        translate([lateral_stem_section / 2, lateral_stem_section / 2, arm_thickness + lateral_offset_h])
            lateral_plot();
    }
}

// ============================================================
// ASSEMBLAGE — pièce unique, rigide, bilatérale
// mirror([1,0,0]) : inverse X seul → triangle latéral identique des 2 côtés
// ============================================================
union() {
    facial_assembly();
    side_arm();
    mirror([1, 0, 0]) side_arm();
}
