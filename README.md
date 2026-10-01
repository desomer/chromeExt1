# Resource Origins

Extension Chrome Manifest V3 qui analyse l'onglet actif et regroupe par origine les feuilles CSS, scripts JavaScript et iframes détectés. Chaque domaine peut être bloqué ou débloqué depuis la liste.

Le popup comporte trois onglets : **Ressources** pour l'analyse et le blocage par domaine, **Éléments** pour inspecter les zones interactives de la page, et **Paramètres** pour la confirmation des nouveaux onglets et la profondeur maximale des iframes.

Les domaines sont affichés selon l'arrivée de leur première requête réseau. Dans chaque domaine, les ressources suivent également leur ordre de téléchargement. Chaque ressource indique aussi le ou les domaines des frames qui l'ont demandée. Les ressources sans mesure de performance disponible sont placées à la fin.

## Éléments interactifs

L'onglet **Éléments** énumère la page principale et toutes ses iframes avec `webNavigation`, puis analyse chaque frame séparément. Les permissions HTTP(S) explicites permettent de couvrir les iframes cross-origin. Il affiche les éléments visibles dont la surface dépasse le seuil **Surface minimale des éléments** configuré dans l'onglet Paramètres (`100000 px²` par défaut) et qui possèdent un écouteur `mousedown`, `pointerdown`, `touchstart`, `click` ou `contextmenu`. Les éléments dont le `z-index` calculé dépasse le seuil **Détection par z-index** (`1000` par défaut) sont également listés, même sans écouteur ou grande surface. `window` et le document principal sont également affichés lorsqu'ils possèdent l'un de ces écouteurs, sans filtre de surface. Le document de chaque iframe est toujours affiché, même sans événement détecté et quelle que soit sa surface. La liste indique la balise ou cible, la frame, le sélecteur CSS, les dimensions, le `z-index` détecté et les événements.

Le résumé indique le nombre de frames analysées et, le cas échéant, le nombre de frames inaccessibles. Chrome interdit notamment l'injection dans certaines pages internes, frames d'autres extensions ou frames protégées.

L'instrumentation commence au chargement de la page. Après une installation ou une mise à jour de l'extension, recharger la page avant l'analyse. Les gestionnaires inline sont également détectés. Lorsqu'un framework place un écouteur délégué sur un conteneur, seul ce conteneur peut être identifié de manière fiable.

Chaque badge d'événement possède un bouton `×` qui retire uniquement cet événement de la cible correspondante dans sa frame. Les autres gestionnaires de la cible restent actifs.

Le bouton **Retirer les événements** supprime, après confirmation, les écouteurs directs souris, pointeur et tactiles des cibles actuellement listées dans toutes les frames. Il couvre également `click`, `dblclick`, `contextmenu` et `wheel`, ainsi que les gestionnaires inline correspondants. Cette modification affecte la page courante seulement et son rechargement restaure son comportement initial.

Le bouton **Retirer les 4 déclencheurs** agit uniquement sur les cibles du dernier scan et supprime exclusivement `mousedown`, `pointerdown`, `contextmenu` et `touchstart`. Les événements comme `click`, `wheel`, `mouseup` ou `touchend` sont conservés.

Le bouton **Retirer clic droit** parcourt toutes les cibles de toutes les frames et retire uniquement leurs gestionnaires `contextmenu`, sans tenir compte du type de cible, du filtre de surface ou de leur présence dans la liste. Il traite les écouteurs suivis par l'instrumentation et les gestionnaires inline.

Les balises `<video>` sont exclues de l'analyse et des deux actions de suppression afin de préserver leurs contrôles et interactions.

Dans chaque frame, l'extension recherche immédiatement puis toutes les 3 secondes les éléments `<div id="dontfoid">` et leur applique `pointer-events: none !important`.

## Blocage des ressources

Le bouton **Bloquer** crée une règle Chrome persistante pour le domaine choisi. Elle bloque globalement ses feuilles CSS, scripts et iframes sur tous les sites. Le blocage ou déblocage devient visible après rechargement de la page.

Après une mise à jour de l'extension, utiliser le bouton **Actualiser** sur `chrome://extensions` afin que Chrome prenne en compte les nouvelles permissions.

## Évaluation avec EasyList

Dans l'onglet **Ressources**, **Vérifier les domaines** compare aussi localement les ressources détectées aux filtres réseau pris en charge de la liste officielle EasyList. La liste est récupérée à la demande puis gardée 12 heures dans le stockage local de l'extension; si le téléchargement échoue, la dernière copie disponible est utilisée. Les URL de la page ne sont pas envoyées à EasyList. Cette évaluation n'ajoute ni ne retire aucune règle DNR et ne bloque aucune requête.

Un résultat **Correspond à EasyList** signifie qu'un filtre réseau pris en charge correspond à l'URL, au type et au contexte évalués; cela ne certifie pas qu'il s'agit d'une publicité. Les filtres cosmétiques et les syntaxes non prises en charge sont ignorés et comptabilisés. Les règles qui distinguent les requêtes de première et de tierce partie utilisent une approximation locale du domaine racine.

L'extension observe les scripts, feuilles CSS et iframes dès l'activation de la page, puis recherche les nouvelles ressources toutes les 3 secondes. Si une nouvelle ressource correspond à EasyList, un panneau dans la page liste l'URL et le filtre correspondant. Le panneau ne bloque pas la ressource; les URL déjà présentes au premier passage servent de référence. Les nouvelles ressources observées sont conservées en session (200 maximum par onglet) et ajoutées à la liste **Ressources** au prochain scan ou clic sur **Actualiser**.

## Réputation des domaines

Dans l'onglet **Ressources**, **Vérifier les domaines** affiche quatre indicateurs pour les origines listées, dont l'âge RDAP. Les domaines enregistrés depuis moins d'un an apparaissent en rouge. La vérification est déclenchée à la demande et demande confirmation, car les URL complètes sont envoyées à Google Safe Browsing, les noms de domaine au résolveur DNS public de Google et au service RDAP, et les IP résolues à AbuseIPDB. Le flux OpenPhish est téléchargé pour une comparaison locale. Google Safe Browsing et AbuseIPDB nécessitent des clés configurables dans **Paramètres** ; elles sont conservées dans le stockage local de l'extension. AbuseIPDB ne juge pas directement un domaine : son score porte sur une seule IP résolue, potentiellement partagée par plusieurs sites. Une absence de signalement n'est pas une garantie de sécurité.

## Profondeur des iframes

Le réglage **Profondeur maximale des iframes** bloque les frames dont le niveau dépasse la valeur choisie. La page principale est au niveau `0` :

- `Désactivé` : aucune limite d'imbrication ;
- `0` : toutes les iframes sont bloquées ;
- `1` : seules les iframes directement intégrées à la page sont autorisées ;
- `2` à `5` : le nombre correspondant de niveaux est autorisé.

Le garde s'exécute au tout début de chaque frame et remplace une frame trop profonde par une page interne. Cette page propose **Supprimer l'iframe** pour retirer directement l'élément correspondant de sa frame parente. Les API publiques Manifest V3 ne permettent pas d'annuler une requête réseau en fonction de sa profondeur avant son démarrage ; quelques octets peuvent donc déjà avoir été transférés. Le changement s'applique immédiatement aux frames actives et aux prochains chargements.

## Confirmation des nouveaux onglets

L'interrupteur **Confirmer les nouveaux onglets** affiche un panneau isolé en haut à droite de la page d'origine avant l'ouverture. Il couvre les liens avec `target="_blank"`, Ctrl/Cmd+clic, le clic avec la molette et les appels JavaScript à `window.open()` sur les pages web HTTP(S). Lorsqu'une ouverture par script est interceptée, `window.open()` renvoie `null` à la page et l'extension crée elle-même l'onglet après autorisation.

Le panneau est rendu dans une iframe de l'extension, elle-même isolée dans un Shadow DOM pour empêcher les styles de la page de l'altérer. Les demandes provenant d'iframes sont remontées vers la page principale et plusieurs demandes sont placées en file d'attente.

Le paramètre **Fermeture automatique** définit le temps accordé pour répondre, entre `1` et `300` secondes. À expiration, la demande est refusée et la suivante est affichée. La valeur `0` désactive cette fermeture. Le panneau affiche le temps restant.

Un service worker surveille également les onglets créés par une page. Lorsqu'une ouverture échappe à l'interception directe, il demande à la page d'origine d'afficher le panneau puis ferme l'onglet provisoire. Celui-ci peut donc apparaître très brièvement. Les onglets ouverts avec le bouton `+` ou les raccourcis propres au navigateur ne sont pas concernés.

Après avoir rechargé l'extension, recharger aussi les pages déjà ouvertes pour y activer la confirmation.

## Installation locale

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer **Mode développeur**.
3. Cliquer sur **Charger l'extension non empaquetée**.
4. Sélectionner ce dossier.
5. Ouvrir une page web puis cliquer sur l'icône de l'extension.

Les pages internes de Chrome et le Chrome Web Store ne permettent pas l'injection de scripts et ne peuvent donc pas être analysés.