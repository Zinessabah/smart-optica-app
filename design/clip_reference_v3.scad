// ============================================================
// Clip de référence optométrique — v3 (imprimable, précision améliorée)
// ============================================================
// Format : OpenSCAD (.scad) — fichier paramétrique, PAS un STL.
// Pour obtenir le fichier imprimable :
//   1. Installer OpenSCAD (gratuit) : openscad.org
//   2. Ouvrir ce fichier
//   3. Design > Render (F6)
//   4. File > Export > Export as STL
// Ligne de commande : openscad -o clip_reference_v3.stl clip_reference_v3.scad
//
// Améliorations v3 vs v2 :
//   • Mires latérales sur la FACE EXTERNE des bras (étiquette orientée ±X,
//     perpendiculaire au bras) → visible de FACE en photo de profil
//     (le motif ne se voit plus de biais comme dans la v2).
//   • Triangle latéral IDENTIQUE des 2 côtés grâce au mirror en X seul
//     (Y,Z préservés) → une seule géométrie à calibrer (positions miroir
//     documentées dans clip_calibration.json).
//   • Pince en U corrigée : évidement central centré, canal ouvert vers le
//     haut, base pleine = épaisseur du bras (rigidité), lèvres flexibles.
//   • Rigidité : barre plus haute (8mm) + nervures entre mires (anti-torsion).
//   • Montant central renforcé (4×4 + 4 goussets) — la 4e mire ne casse pas.
//   • Congés (fillets) sur tous les plots → meilleure impression FDM.
//   • Paramètres groupés par section, tous ajustables en tête de fichier.
//
// À ajuster après mesure réelle (voir "À MESURER" ci-dessous) :
//   clamp_gap : épaisseur de la branche/charnière (2.5–4 mm selon monture)
//   stem_height : hauteur du montant (liée à l'espace front-clip)
// ============================================================

$fn = 64; // résolution (96 pour le rendu final, 48 pour preview rapide)

// ===== [1] BARRE FACIALE =====
facial_half_span    = 50;   // mm, centre -> mire gauche/droite (50mm = specs clip actuel)
bar_thickness       = 3;    // mm, épaisseur de la barre
bar_height          = 8;    // mm, hauteur de la barre (augmentée vs v2 : rigidité anti-torsion)
bar_margin          = 15;   // mm, dépassement au-delà des mires vers les bras
rib_height          = 3;    // mm, nervures de rigidité sous la barre (entre les mires)
rib_thickness       = 2;    // mm, épaisseur d'une nervure

// ===== [2] MIRES FACIALES (3 colinéaires + 1 hors-axe) =====
facial_pad_outer_d   = 12;   // mm, diamètre externe (specs réelles du clip)
facial_pad_inner_d   = 10;   // mm, diamètre interne du motif étiquette
facial_pad_thickness = 1.5;  // mm, épaisseur du plot support
label_recess         = 0.15; // mm, renfoncement pour coller l'étiquette à plat

// ===== [3] 4e MIRE HORS-AXE (lève la colinéarité → solvePnP stable) =====
stem_height           = 15;  // mm, hauteur du montant central
stem_section          = 4;   // mm, section carrée du montant (renforcé vs v2)
stem_gusset           = 6;   // mm, taille des goussets de renfort à la base

// ===== [4] BRAS LATÉRAUX =====
arm_length            = 55;  // mm, longueur du bras depuis la barre
arm_thickness         = 3;   // mm, épaisseur du bras
// arm_width est dérivé de la pince : 2 lèvres + canal (voir [6])

// ===== [5] MIRES LATÉRALES (3 non-colinéaires, face EXTERNE) =====
lateral_pad_d         = 6;   // mm, plot support (motif visuel = 4mm sur étiquette)
lateral_baseline      = 35;  // mm, écart mire1-mire2 le long du bras (vs 25mm → précision)
lateral_offset_h      = 18;  // mm, hauteur du montant de la 3e mire (hors plan du bras)
lateral_stem_section  = 5;   // mm, section carrée du montant portant la 3e mire
lateral_protrude      = 5;   // mm, dépassement du plot hors de la face externe du bras
lateral_start         = 12;  // mm, distance première mire depuis le début du bras

// ===== [6] PINCE EN U (canal ouvert vers le haut, sans vis) =====
clamp_len             = 12;  // mm, longueur du canal (le long du bras)
clamp_gap             = 3.2; // mm, — À MESURER — épaisseur réelle de la branche/charnière
clamp_lip_thickness   = 1.2; // mm, épaisseur des lèvres flexibles
clamp_lip_height      = 6;   // mm, hauteur des lèvres au-dessus de la base

// ============================================================
// MODULES
// ============================================================

// Plot support d'étiquette avec chanfrein de base (fusionné) + renfoncement
// ⚠️ Cône tronqué (d1 > d2) au lieu d'un tore : le chanfrein CHEVAUCHE le
// cylindre → volume unique garanti (le tore rotate_extrude ne faisait que
// toucher le cylindre → CGAL comptait des volumes séparés !)
module marker_pad(d, h, recess) {
    chamfer = 1.0;
    // base chanfreinée (45°) : fusionne avec le plan support ET le cylindre
    cylinder(d1 = d + 2 * chamfer, d2 = d, h = chamfer);
    // corps du plot
    translate([0, 0, chamfer]) {
        difference() {
            cylinder(d = d, h = h);
            if (recess > 0)
                // ⚠️ Le creux doit TRAVERSER la surface supérieure (z = h - recess)
                // → poche OUVERTE = 1 volume. Un creux interne fermé = volume CGAL séparé !
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

module facial_assembly() {
    union() {
        // barre continue
        translate([-(facial_half_span + bar_margin), -bar_height / 2, 0])
            cube([2 * (facial_half_span + bar_margin), bar_height, bar_thickness]);

        // nervures de rigidité
        facial_ribs();

        // 3 mires colinéaires (gauche, centre, droite)
        // z = bar_thickness - SINK : la base pénètre dans la barre →
        // intersection volumique CGAL (une pose à fleur ne fusionne pas)
        for (x = [-facial_half_span, 0, facial_half_span])
            translate([x, 0, bar_thickness - 0.6])
                marker_pad(facial_pad_outer_d, facial_pad_thickness, label_recess);

        // montant central + 4e mire hors-axe (anti-colinéarité)
        // ⚠️ Le montant part SOUS la surface de la barre (z = -SINK) →
        // pénètre dans la barre → fusion CGAL (à fleur = volume séparé)
        translate([-stem_section / 2, -stem_section / 2, -0.8])
            union() {
                cube([stem_section, stem_section, stem_height + 0.8]);
                // 4 goussets de renfort à la base (partent du fond de la barre)
                for (a = [0, 90, 180, 270])
                    rotate([0, 0, a])
                        translate([0, -stem_section / 2, 0])
                            linear_extrude(height = stem_gusset * 0.6)
                                polygon([[0, 0], [stem_gusset, 0], [0, stem_gusset]]);
            }
        // 4e mire : base enfoncée dans le sommet du montant
        // (le montant part de z=-0.8, sa hauteur totale = stem_height)
        translate([0, 0, stem_height - 0.6])
            marker_pad(facial_pad_outer_d, facial_pad_thickness, label_recess);
    }
}

// Pince en U : base pleine (= bras) + 2 lèvres, canal ouvert vers le haut
// La branche (en Z) traverse le canal ; les lèvres en Y pincent par flexion.
module hinge_clamp() {
    w = 2 * clamp_lip_thickness + clamp_gap;   // largeur totale de la pince
    total_h = arm_thickness + clamp_lip_height;
    translate([0, -w / 2, 0])
        difference() {
            cube([clamp_len, w, total_h]);
            // évidement du canal (ouvert vers le haut, base = arm_thickness)
            translate([-0.05, clamp_lip_thickness, arm_thickness])
                cube([clamp_len + 0.1, clamp_gap, clamp_lip_height + 0.05]);
        }
}

// Plot latéral : cylindre dont l'axe est Y (perpendiculaire au bras).
// La face plane de l'étiquette regarde ±Y = vers l'EXTÉRIEUR du bras
// (visible de FACE sur la photo de profil, pas de biais).
// rotate([90,0,0]) : axe Z → axe Y.
// SINK : base enfoncée dans le bras → fusion CGAL (pose à fleur = volume séparé)
module lateral_plot(sink = 0.6) {
    translate([0, -sink, 0])
        rotate([90, 0, 0])
            marker_pad(lateral_pad_d, lateral_protrude, label_recess * 0.6);
}

module side_arm() {
    x0 = facial_half_span + bar_margin;
    w = 2 * clamp_lip_thickness + clamp_gap;
    // ⚠️ Le bras part SOUS la surface (x0 - SINK) → pénètre dans la barre
    // (à fleur = contact surfacique = volume CGAL séparé)

    // bras
    translate([x0 - 0.8, -w / 2, 0])
        cube([arm_length + 0.8, w, arm_thickness]);

    // pince en bout de bras (canal ouvert vers le haut)
    translate([x0 + arm_length - clamp_len, 0, 0])
        hinge_clamp();

    // 3 mires latérales non-colinéaires sur la face externe
    //  - mire 1 et 2 : dans le plan du bras, espacées de lateral_baseline
    //  - mire 3 : portée par un MONTANT (au-dessus du bras) → triangle 3D
    //    ⚠️ v2 bug : la 3e mire était posée dans le vide (z=+18mm), sans support
    translate([x0 + lateral_start, 0, arm_thickness]) {
        translate([0, w / 2, 0])
            lateral_plot();
        translate([lateral_baseline, w / 2, 0])
            lateral_plot();
    }

    // montant de la 3e mire : part du FOND du bras (z=0) → fusionne avec le bras
    translate([x0 + lateral_start + lateral_baseline / 2 - lateral_stem_section / 2,
               w / 2 - lateral_stem_section, 0]) {
        cube([lateral_stem_section, lateral_stem_section, arm_thickness + lateral_offset_h]);
        // 3e mire au sommet du montant, face d'étiquette vers l'extérieur (+Y)
        translate([lateral_stem_section / 2, lateral_stem_section / 2, arm_thickness + lateral_offset_h])
            lateral_plot();
    }
}

// ============================================================
// ASSEMBLAGE — pièce unique, rigide, bilatérale
// mirror([1,0,0]) : inverse X seulement → Y,Z préservés →
// le triangle latéral est identique des 2 côtés (1 seule calibration)
// ============================================================
union() {
    facial_assembly();
    side_arm();
    mirror([1, 0, 0]) side_arm();
}
