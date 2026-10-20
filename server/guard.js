'use strict';
// Premier filtre, purement textuel, contre les extensions JavaScript de SaxonJS.
// La vraie protection est dans evaluator.js (JS neutralisé) et le Permission Model de Node ;
// ce filtre sert surtout à renvoyer un message clair à l'étudiant.

const FORBIDDEN = [
  [/saxonica\.com\/ns\/(interactiveXSLT|globalJS)/i, 'les extensions JavaScript de SaxonJS (ixsl, js)'],
  [/(^|[^\w.-])(ixsl|js)\s*:\s*[\w*-]/, 'les extensions JavaScript de SaxonJS (préfixes ixsl: et js:)'],
];

function checkSource(text) {
  for (const [re, what] of FORBIDDEN) {
    if (re.test(text)) return `Non autorisé sur ce serveur : ${what}.`;
  }
  return null;
}

module.exports = { checkSource };
