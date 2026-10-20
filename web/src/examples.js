// Exemples cliquables : spécifiques à mondial.xml, ou génériques pour les autres documents.

export const MONDIAL_EXAMPLES = [
  {
    group: 'Chemins simples',
    items: [
      ['/mondial/country/name', 'Le nom de tous les pays'],
      ['count(//country)', 'Nombre de pays'],
      ["//country[@car_code='MA']", 'Le pays dont le code est MA'],
      ["//country[@car_code='MA']//city/name", 'Les villes du Maroc'],
    ],
  },
  {
    group: 'Prédicats',
    items: [
      ['//country[population[last()] > 100000000]/name', 'Pays de plus de 100 millions d’habitants (dernier recensement)'],
      ["//country[encompassed/@continent = 'africa']/name", 'Pays d’Afrique'],
      ['//river[length > 4000]/name', 'Fleuves de plus de 4000 km'],
      ['//country[count(border) >= 9]/name', 'Pays ayant au moins 9 voisins'],
    ],
  },
  {
    group: 'Axes et jointures',
    items: [
      ["//city[name = 'Rabat']/ancestor::country/name", 'Le pays qui contient Rabat'],
      ["let $cap := //country[@car_code = 'MA']/@capital\nreturn //city[@id = $cap]/name",
        'La capitale du Maroc (jointure par identifiant ; le let évite de réévaluer //country pour chaque ville)'],
      ["let $voisins := //country[@car_code = 'MA']/border/@country\nreturn //country[@car_code = $voisins]/name", 'Les voisins du Maroc'],
      ["//city[name = 'Casablanca']/following-sibling::city/name", 'Les villes qui suivent Casablanca dans sa province'],
    ],
  },
  {
    group: 'Fonctions',
    items: [
      ["sum(//country[encompassed/@continent = 'europe']/@area)", 'Superficie totale de l’Europe (km²)'],
      ['round(avg(//country/infant_mortality), 2)', 'Mortalité infantile moyenne'],
      ['count(distinct-values(//language))', 'Nombre de langues distinctes'],
      ["string-join(//country[encompassed/@continent = 'australia']/name, ', ')", 'Pays d’Océanie, en une chaîne'],
    ],
  },
  {
    group: 'XPath 3.1',
    items: [
      ["for $c in //country[encompassed/@continent = 'africa'][position() <= 10]\nreturn $c/name || ' : ' || $c/population[last()]", 'for … return et concaténation'],
      ['let $m := //mountain\nreturn $m[elevation = max($m/elevation)]/name', 'let : la plus haute montagne'],
      ['sort(//country, (), function($c) { -number($c/population[last()]) })[position() <= 10]/name', 'Les 10 pays les plus peuplés (sort + fonction)'],
      ["map:merge(\n  for $c in //continent\n  return map { string($c/name) : count(//country[encompassed/@continent = $c/@id]) }\n)", 'Une map : nombre de pays par continent'],
      ["array { //country[@car_code = 'MA']/language/string() }", 'Un tableau des langues du Maroc'],
    ],
  },
];

export const GENERIC_EXAMPLES = [
  {
    group: 'Explorer le document',
    items: [
      ['/*', 'L’élément racine'],
      ['count(//*)', 'Nombre total d’éléments'],
      ['distinct-values(//*/name())', 'Noms d’éléments distincts'],
      ['distinct-values(//@*/name())', 'Noms d’attributs distincts'],
      ['//*[not(*)][normalize-space()]', 'Éléments feuilles non vides'],
      ['/*/*[1]', 'Premier enfant de la racine'],
    ],
  },
];

export const MONDIAL_XSLT = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="3.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:f="urn:fonctions-locales"
    exclude-result-prefixes="xs f">

  <xsl:output method="html" indent="yes"/>

  <xsl:key name="city" match="city" use="@id"/>

  <!-- Population la plus récente d'un pays -->
  <xsl:function name="f:pop" as="xs:double">
    <xsl:param name="c" as="element(country)"/>
    <xsl:sequence select="number(($c/population)[last()])"/>
  </xsl:function>

  <xsl:template match="/mondial">
    <html>
      <head>
        <style>
          body { font-family: system-ui, sans-serif; margin: 16px; }
          table { border-collapse: collapse; margin-bottom: 24px; }
          th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: left; }
          th { background: #eef2f8; }
          td.num { text-align: right; }
        </style>
      </head>
      <body>
        <h1>Les 5 pays les plus peuplés de chaque continent</h1>
        <xsl:for-each-group select="country" group-by="encompassed[1]/@continent">
          <xsl:sort select="current-grouping-key()"/>
          <h2><xsl:value-of select="//continent[@id = current-grouping-key()]/name"/>
            (<xsl:value-of select="count(current-group())"/> pays)</h2>
          <table>
            <tr><th>Pays</th><th>Capitale</th><th>Population</th></tr>
            <xsl:for-each select="current-group()">
              <xsl:sort select="f:pop(.)" order="descending"/>
              <xsl:if test="position() le 5">
                <tr>
                  <td><xsl:value-of select="name[1]"/></td>
                  <td><xsl:value-of select="key('city', @capital)/name[1]"/></td>
                  <td class="num"><xsl:value-of select="format-number(f:pop(.), '#,##0')"/></td>
                </tr>
              </xsl:if>
            </xsl:for-each>
          </table>
        </xsl:for-each-group>
        <xsl:message>Continents traités : <xsl:value-of select="count(continent)"/></xsl:message>
      </body>
    </html>
  </xsl:template>

</xsl:stylesheet>
`;

export const GENERIC_XSLT = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="3.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

  <xsl:output method="html" indent="yes"/>

  <xsl:template match="/">
    <html>
      <body style="font-family: system-ui, sans-serif">
        <h1>Éléments de &lt;<xsl:value-of select="name(/*)"/>&gt;</h1>
        <table border="1" cellpadding="4">
          <tr><th>Élément</th><th>Occurrences</th></tr>
          <xsl:for-each-group select="//*" group-by="name()">
            <xsl:sort select="count(current-group())" order="descending"/>
            <tr>
              <td><xsl:value-of select="current-grouping-key()"/></td>
              <td><xsl:value-of select="count(current-group())"/></td>
            </tr>
          </xsl:for-each-group>
        </table>
      </body>
    </html>
  </xsl:template>

</xsl:stylesheet>
`;
