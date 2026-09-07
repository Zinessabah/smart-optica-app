// ============================================================
// Clip de référence optométrique — v4
// ============================================================
// Corrections apportées par rapport à la v3 :
//   1. Les bras repartent vers l'ARRIÈRE (axe Y, le long de la tempe)
//      au lieu de continuer sur l'axe X. Largeur totale ramenée à
//      ~120mm (au lieu de 240mm), réaliste pour une paire de lunettes.
//   2. Montant central réintroduit sur la barre faciale (4e mire
//      hors-axe) : la vue de face n'est plus en configuration
//      colinéaire dégénérée pour solvePnP.
//   3. Poteaux (central + latéral) redessinés en tronc de cône évasé
//      à la base, au lieu de tiges fines à section constante — bien
//      plus rigide pour un encombrement similaire.
//   4. Bras et lèvres de pince légèrement épaissis (moins de flexion
//      sous manipulation).
//
// Repère utilisé DANS CE FICHIER (convention d'impression, distincte
// du repère anatomique du clip_calibration.json) :
//   X = largeur (gauche/droite, le long de la barre faciale)
//   Y = profondeur (vers l'arrière, le long de la tempe)
//   Z = hauteur (axe d'impression, vertical sur le plateau)
//
// Rendu : ouvrir dans OpenSCAD (openscad.org) > Design > Render (F6)
//         > File > Export > Export as STL
//
// ============================================================
// v4.1 — corrections appliquées après rendu/analyse (11-08) :
//   1. Sink 0.8 : toutes les mires/poteaux/bras pénètrent dans leur
//      support → union volumique, plus de faces coplanaires exactes
//      (le fichier d'origine n'était PAS un 2-manifold : "Volumes: 2").
//   2. marker_pad : disque PLEIN (le recess 0.15 créait un 2e volume
//      CGAL) — l'étiquette se colle sur la face plane.
//   3. tapered_post : le cône chevauche le hull de 0.15 (face
//      coplanaire au sommet du hull supprimée).
//   4. Mires latérales : plots cylindriques ORIENTÉS LE LONG DE X
//      (perpendiculaires au bras) → face visible de profil (caméra
//      le long de X), comme la v3. Le plot traverse le bras
//      (lateral_marker_len = arm_width + 4) et dépasse à l'extérieur.
// ============================================================

$fn = 48;

// ===== Barre faciale =====
facial_half_span     = 50;   // mm, mesuré
bar_thickness         = 3;
bar_height            = 6;
bar_margin            = 12;  // mm, dépassement avant la pince
                             // v4.2 : 10 → 12 — la pince démarre à x0-4 = 58
                             // et le bord des mires faciales Ø12 (±50) est à 56
                             // → 2 mm de jeu (plus de tangence non-manifold)

// ===== Mires faciales =====
facial_pad_outer_d    = 12;  // mm, mesuré
facial_pad_inner_d    = 10;  // mm, info pour l'étiquette (anneau) — non gravé ici
facial_pad_thickness  = 1.5;
label_recess          = 0.15;

// ===== Montant central (anti-colinéarité, vue de face) =====
stem_height           = 14;
stem_base_d           = 7;   // diamètre évasé à la base (rigidité)
stem_top_d            = 4;   // diamètre au sommet
stem_flare_h          = 3;   // hauteur de l'évasement

// ===== Pince (canal en C, sans vis) =====
clamp_len              = 10;  // mm, le long de Y
clamp_gap              = 3.2; // mm — À AJUSTER à l'épaisseur réelle de charnière
clamp_lip_thickness     = 1.2;
clamp_depth             = 8;   // mm, le long de X

// ===== Bras latéral (reparti vers l'arrière, axe Y) =====
arm_length             = 50;  // mm, longueur utile derrière la pince
arm_width               = 7;   // mm (axe X)
arm_thickness           = 4;   // mm (axe Z)

// ===== Mires latérales (3 non-colinéaires) =====
lateral_pad_d           = 6;   // plot support (motif visuel = 4mm sur étiquette)
lateral_start_offset    = 8;   // mm, décalage du 1er marqueur depuis le début du bras
lateral_baseline        = 35;  // écart mire1-mire2 le long du bras (axe Y)
lateral_post_height     = 10;  // hauteur du poteau de la 3e mire
lateral_post_base_d     = 6;
lateral_post_top_d      = 3;
lateral_post_flare_h    = 2.5;

// ===== Fusion volumique (2-manifold) =====
sink                 = 0.8;  // mm, pénétration mires/poteaux dans la barre/bras
                             // (évite les faces coplanaires → STL non-manifold)
lateral_marker_len   = arm_width + 4;  // mm, longueur du plot latéral :
                             // traverse le bras (7) + saillie 4 mm à l'extérieur
                             // → mire visible de profil (caméra le long de X)

// ============================================================
// MODULES
// ============================================================

module marker_pad(d, h, recess) {
    // Disque plein : le recess (évidement pour l'étiquette) créait une
    // face coplanaire exacte → non-manifold CGAL (Volumes: 2). L'étiquette
    // se colle directement sur la face plane du disque.
    cylinder(d = d, h = h);
}

// Poteau en tronc de cône, évasé à la base pour la rigidité
module tapered_post(base_d, top_d, height, flare_d, flare_h) {
    union() {
        hull() {
            cylinder(d = flare_d, h = 0.01);
            translate([0, 0, flare_h])
                cylinder(d = base_d, h = 0.01);
        }
        // cône démarré 0.15 PLUS BAS que le sommet du hull → chevauchement
        // volumique (évite la face coplanaire exacte → non-manifold CGAL)
        translate([0, 0, flare_h - 0.15])
            cylinder(d1 = base_d, d2 = top_d, h = height - flare_h + 0.15);
    }
}

// Mire latérale : plot cylindrique orienté le long de X (perpendiculaire
// au bras) → face visible de profil (caméra le long de X, comme la v3)
// Le plot pénètre dans le bras (sink) → fusion volumique 2-manifold.
module lateral_marker() {
    // orienté le long de X : base = face interne du bras, sommet = face externe
    rotate([0, 90, 0])
        translate([0, 0, -(lateral_marker_len / 2)])
            marker_pad(lateral_pad_d, lateral_marker_len, label_recess * 0.6);
}

module facial_assembly() {
    union() {
        // barre continue
        translate([-(facial_half_span + bar_margin), -bar_height / 2, 0])
            cube([2 * (facial_half_span + bar_margin), bar_height, bar_thickness]);

        // 3 mires colinéaires (gauche, centre, droite) — sink 0.8 dans la barre
        for (x = [-facial_half_span, 0, facial_half_span])
            translate([x, 0, bar_thickness - sink])
                marker_pad(facial_pad_outer_d, facial_pad_thickness, label_recess);

        // montant central + 4e mire hors-axe (anti-colinéarité, vue face)
        // montant sinké dans la barre ; mire du sommet sinkée dans le montant
        // (2*sink : le montant est lui-même décalé de -sink, sa mire doit
        // pénétrer de sink dans le sommet du cône → 16.2 - 0.8 = 15.4)
        translate([0, 0, bar_thickness - sink])
            tapered_post(stem_base_d, stem_top_d, stem_height, stem_base_d * 1.3, stem_flare_h);
        translate([0, 0, bar_thickness + stem_height - 2 * sink])
            marker_pad(facial_pad_outer_d, facial_pad_thickness, label_recess);
    }
}

module hinge_clamp() {
    // canal en C, ouvert vers le haut (Z) — pince par flexion du plastique
    union() {
        cube([clamp_depth, clamp_len, clamp_lip_thickness]);
        cube([clamp_lip_thickness, clamp_len, arm_thickness + 3]);
        translate([clamp_lip_thickness + clamp_gap, 0, 0])
            cube([clamp_lip_thickness, clamp_len, arm_thickness + 3]);
    }
}

module side_arm_right() {
    x0 = facial_half_span + bar_margin;

    // pince, au bout de la barre (grippe la charnière)
    translate([x0 - clamp_depth / 2, 0, 0])
        hinge_clamp();

    // bras vers l'arrière (axe Y), depuis la pince, le long de la tempe
    // commence à clamp_len - sink → pénètre dans la pince (fusion volumique)
    translate([x0 - arm_width / 2, clamp_len - sink, 0])
        cube([arm_width, arm_length + sink, arm_thickness]);

    // 2 mires alignées le long du bras + 1 mire surélevée hors-axe,
    // toutes orientées le long de X (visibles de profil) et sinkées
    // dans le bras (z = arm_thickness - sink)
    translate([x0, clamp_len + lateral_start_offset, arm_thickness - sink]) {
        lateral_marker();
        translate([0, lateral_baseline, 0])
            lateral_marker();
        // poteau de la 3e mire, sinké dans le bras
        translate([4, lateral_baseline / 2, 0])
            tapered_post(lateral_post_base_d, lateral_post_top_d, lateral_post_height,
                         lateral_post_base_d * 1.3, lateral_post_flare_h);
        // mire du sommet du poteau : orientée le long de X (visible de profil)
        // et sinkée dans le poteau
        translate([4, lateral_baseline / 2, lateral_post_height - sink])
            rotate([0, 90, 0])
                marker_pad(lateral_pad_d, lateral_marker_len, label_recess * 0.6);
    }
}

// ============================================================
// ASSEMBLAGE COMPLET — pièce unique, rigide, bilatérale
// ============================================================
union() {
    facial_assembly();
    side_arm_right();
    mirror([1, 0, 0]) side_arm_right();
}
