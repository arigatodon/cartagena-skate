# Cartagena Skate

Juego 3D de descenso en skate sobre el recorrido real de **Cartagena, Región de
Valparaíso, Chile**.

**Etapa 1 — Av. Cartagena 1555 → Playa Chica.** 2,14 km, 111 m de desnivel,
13 % de pendiente máxima. Carrera de tres corredores.

## Cómo jugar

No necesita instalar nada ni compilar. Como usa módulos ES, hay que servirlo por
HTTP (abrir el archivo con `file://` no funciona):

```bash
python3 -m http.server 8000
# abrir http://localhost:8000
```

Requiere un navegador con WebGL.

### Controles

| Tecla | Acción |
|---|---|
| `←` `→` | Girar |
| `↑` | Empujar |
| `↓` | Frenar |
| `Ctrl` | Tuck — baja el arrastre |
| `Espacio` | Ollie (mantener para cargar) |
| `Shift` + girar | **Derrape** |
| `Shift` junto a una baranda | **Grind** |
| `Q` `E` | Girar en el aire |
| `J` `K` `L` `U` `I` | Kickflip · Heelflip · Pop Shove-it · Varial · Impossible |
| `R` `P` `M` | Reiniciar · Pausa · Silencio |

Las maniobras encadenadas sin tocar el suelo suben el multiplicador (tope x8).
El combo se cobra al aterrizar limpio, al salir de una baranda o al cerrar un
derrape. Hay que **aterrizar alineado**: si tocas el suelo a más de 75° del
múltiplo de 360° más cercano, o con un truco de tabla a medio hacer, te caes.

### La carrera

Bajan **tres**. Los dos rivales no son fantasmas con velocidad prefijada: corren
con la misma clase `Player` y la misma física que tú, así que una caída los
frena de verdad y un turbo los acelera de verdad.

Lo que los distingue es la **prudencia en curva**, que resultó ser la perilla
que importa: en una bajada la velocidad la pone la gravedad, así que si todos
van en tuck y nadie frena, todos hacen el mismo tiempo. El rival tranquilo
levanta el pie en las curvas cerradas; el picante las toma enteras.

Contra simulación, con un piloto humano decente:

| | Tiempo |
|---|---|
| Rival picante | 120 s |
| Piloto humano decente | 123 s |
| Rival tranquilo | 136 s |

### Personajes

Se elige en el menú y se recuerda entre sesiones. Los dos rivales se sortean
entre los que no elegiste, cada uno con sus propias estadísticas.

| | Altura | Velocidad | Giro | Salto |
|---|---|---|---|---|
| **El Rucio** | 1,78 m | 1,06 | 0,94 | 0,97 |
| **La Colo** | 1,68 m | 0,97 | 1,10 | 1,08 |
| **El Arañita** | 1,28 m | 0,94 | 1,18 | 1,16 |
| **El Porotito** | 1,06 m | 1,02 | 1,04 | 0,88 |
| **El Murciélago** | 1,86 m | 1,10 | 0,88 | 0,94 |
| **El Meteoro** | 1,84 m | 1,04 | 0,98 | 1,22 |

La velocidad multiplica el arrastre aerodinámico (más pesado rueda más suelto),
el giro la autoridad lateral y el salto la potencia del ollie y de las rampas.

Los dos últimos son homenajes genéricos: capucha con orejas y capa oscura el
uno, capa roja y traje azul el otro. Sin logos ni nombres de nadie.

### Los pies van sobre los ejes

Las piernas se resuelven con **cinemática inversa de dos huesos**: se le dice
dónde tiene que quedar el pie y de ahí salen los ángulos de muslo y rodilla.

Girar los muslos «a ojo» y esperar que el pie cayera cerca no funciona: los
pies terminaban a 55 cm uno del otro, asimétricos, y uno de los dos atravesaba
la tabla. Con la IK quedan clavados sobre los trucks pase lo que pase con la
flexión, el tuck o el salto.

Lo mismo con el grind: la altura del tubo (`railY`) la calcula `track.js` y la
usan LOS DOS lados —la malla que se dibuja y la altura a la que el renderizador
sube al skater—. Cuando sólo la sabía el renderizador, la baranda le pasaba por
la cintura.

## El recorrido

**Nada de esto está dibujado a mano.** `js/route-data.js` se genera con
`tools/build-route.py`, que encadena las vías reales de OpenStreetMap en orden
de bajada y les pega el perfil de elevación SRTM 30 m:

| Desde | Tramo | Qué hay |
|---|---|---|
| 0 m | Av. Cartagena Alto | Calzada simple, casas bajas, el mar al fondo de la calle |
| 560 m | **Bandejón** | Empieza la calzada dividida: platabanda con pasto y árboles |
| 830 m | Monumento | El barco del Club Unión Libertad, sobre el bandejón |
| 1180 m | Bajada al centro | Sigue el bandejón, aparece el comercio |
| 1470 m | **Plaza de Cartagena** | Primera curva, se rodea la plaza |
| 1560 m | Municipalidad | Mariano Casanova, edificio y busto |
| 1670 m | **Zigzag** | Curvas cerradas y empinadas bajando a la playa |
| 1950 m | Costanera — Playa Chica | Paseo con baranda, **el mar a la derecha** |

La calzada dividida no es un adorno: Av. Cartagena está mapeada en OSM como dos
vías paralelas entre los metros 560 y 1520, y esa platabanda central es la
baranda de grind más larga del juego.

### El mar es una bahía, no un plano

El agua se construye extendiendo la **línea de costa real** hacia el poniente, y
el terreno se hunde sólo del lado del mar. Por eso al llegar a Playa Chica el
Pacífico queda **a la derecha** —a unos 95 m— y de frente sigue habiendo cerro,
casas y la subida hacia San Antonio, igual que en la calle.

Saber si un punto está en el agua se resuelve con un test de paridad de cruces
contra la línea de costa. La versión simple («¿está al poniente del punto de
orilla más cercano?») falla en una bahía: un punto en pleno mar puede quedar al
oriente del vértice más próximo si ése pertenece a una punta rocosa, y aparecían
cerros flotando en medio del agua.

### Precisión

El trazado dibujado se reconstruye integrando los rumbos **suavizados** (ventana
de 35 m), no los puntos GPS crudos, para que el asfalto tenga exactamente la
curvatura que siente la física y las esquinas del callejero se conviertan en
curvas de radio realista (mínimo 27 m). El precio es que recorta las esquinas.

El perfil de elevación conserva la forma del SRTM pero tiene los extremos
anclados a las cotas de Google (123 m y 12 m): el SRTM mide la superficie —
techos y copas incluidos— y en zona urbana lee unos 10 m alto.

El monumento del barco es el único elemento posicionado por estimación, a partir
de la numeración municipal (Av. Cartagena 912 ≈ metro 830); todo lo demás sale
de coordenadas.

## Física

La aceleración sale de la pendiente real del tramo menos rozamiento de rodadura
y arrastre aerodinámico cuadrático. Velocidades terminales:

| Pendiente | De pie | En tuck |
|---|---|---|
| 3 % (salida) | ~31 km/h | — (hay que empujar) |
| 6 % | ~53 km/h | ~64 km/h |
| 9 % | ~68 km/h | ~81 km/h |
| 13 % (zigzag) | ~88 km/h | tope |

Tope duro 28 m/s (~101 km/h). Los semianchos de colisión están en metros y
coinciden con las medidas de las mallas: lo que ves es lo que te choca.

La física corre a paso fijo de 1/120 s, desacoplada del render, así que se
comporta igual en un monitor de 60 Hz que en uno de 144 Hz.

Contra simulación headless, un piloto que sólo esquiva y busca turbos baja en
~127 s con 0 caídas y 16.000 puntos.

## Convención de ejes

`x = este`, `y = arriba`, `z = SUR`.

El sur, no el norte. Three.js usa un sistema diestro, y en un marco diestro con
x=este e y=arriba el tercer eje es forzosamente el sur. Mapear z al norte da un
marco zurdo: **el mundo entero se renderiza en espejo** y el mar termina al lado
contrario del que está en la realidad. De ahí sale también el vector derecha,
`(-cos h, 0, sin h)` = `adelante × arriba`.

Consecuencia práctica: al construir cintas (calzada, veredas, bandejón, mar) el
primer vértice de cada par es el borde IZQUIERDO, y el giro de los triángulos
tiene que ser `(a, a+1, a+2)`. Con el opuesto la normal apunta hacia abajo y la
malla desaparece por *backface culling*.

## Estructura

```
index.html            HUD, menús y selector de personaje
css/style.css         Estilos
vendor/
  three.module.js     Three.js r160 (MIT), incluido para funcionar sin conexión
tools/
  build-route.py      Regenera route-data.js desde OSM + SRTM
js/
  route-data.js       GENERADO: eje, costa, playas y plaza en lat/lon
  track.js            Datos → segmentos, curva 3D muestreable y decorado
  render3d.js         Escena WebGL: terreno, mar, pueblo, hitos y cámara
  characters.js       Los tres personajes, con esqueleto y animación
  textures.js         Texturas procedurales (sin archivos de imagen)
  bots.js             IA de los rivales y tabla de posiciones
  player.js           Física del skater y resolución de maniobras
  tricks.js           Catálogo de trucos, combos y puntaje
  audio.js            Sonido sintetizado con WebAudio
  game.js             Bucle principal, entrada, estados y HUD
```

Todos los gráficos y sonidos se generan en runtime. La única dependencia es
Three.js, incluida en `vendor/`.

Rendimiento medido: 2,8 ms por frame, 225 draw calls, 57k triángulos.

Desde la consola del navegador, `window.CS` expone
`{ view, player, track, bots, corredores }` para inspeccionar la escena, la
física y la carrera.

## Créditos de datos

- Geometría de calles, costa, playas y plaza: © colaboradores de
  [OpenStreetMap](https://www.openstreetmap.org/copyright), licencia ODbL.
- Elevación: SRTM 30 m vía [OpenTopoData](https://www.opentopodata.org/).
