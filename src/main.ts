/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    scan,
    switchMap,
    take,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    TICK_RATE_MS: 50, // Might need to change this!
    GRAVITY: 1.6,       //pixels fallen per tick
    FLAP: 10,             //pixels 'jumped' when flapped
    SCROLL: 7,           //speed which field horizontally scrolls
    // PIPE_GAP: 100,       //vertical gaps that the bird must fly through
    // PIPE_GENERATE_RATE: 1200,   //speed in ms to generate pipe
    // PIPE_SPACE: 150,            //space between pipes
    BIRD_X: 3,                  //pixels which bird moves rightward 
    // NUM_PIPES: 4,               //total number of pipes
} as const;

//Pipe type
type Pipe = Readonly<{
  id: number;
  frame: number;    // frame where the pipe exists
  gapY: number;     //middle of gap
  gapHeight: number;    //height of gap 
}>;

type ScheduleItem = Readonly<{
  appearTime: number;       //time (in ms) that the pipe should exist in the frame X position
  gapY: number;             //middle of gap
  gapHeight: number;        //height of gap
}>;

// User input

type Key = "Space";

// State processing

type State = Readonly<{
    gameEnd: boolean;
    birdY: number;   //vertcial position of the bird
    birdVelocity: number;   //velocity of bird (speed at which it falls)
    scrollX: number;        //position of frame in the field
    pipes: ReadonlyArray<Pipe>;     //list containing pipes in frame
    nextPipe: number;               //id for next pipe
    nextPipeX: number;              //x position for next pipe
    birdX: number;                  //x position of bird
    birdLives: number;
    hitCooldown: number;            //cooldown ticks after bird hits
    score: number;                  //player score
    elapsedMs: number;              //time progressed since start
    pending: ReadonlyArray<ScheduleItem>; //pipes not yet spawned
    totalPipes: number;     //total number of scheduled pipes
}>;

const InitialState = (pending: ReadonlyArray<ScheduleItem>): State => ({
    gameEnd: false,
    birdY: Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2, //bird starts at centre (vertical pos is at centre)
    birdVelocity: 0,        //bird stationary at start
    scrollX: 0,             //frame begins at 0
    pipes: [],              //start with no pipes
    nextPipe: 0,             //initial pipe
    nextPipeX: 0,            //next pipe x coord
    birdX: Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2,    //start position given in original code
    birdLives: 3,           //starts with 3
    hitCooldown: 0,         //cooldown after a hit to prevent overlapping hits
    score: 0,               //initially 0
    elapsedMs: 0,           //time not yet progressed
    pending,                //list of scheduled pipes not yet spawned
    totalPipes: pending.length, //
});  

//REMOVED helper functions below so CSV can control pipe generating/spawning
// //helper function to calculate pipeGap (gaps in pipes bird can ply through)
// const pipeGap = (): number => {

//     //ensure both gaps remain on screen
//     const min = Constants.PIPE_GAP / 2;
//     const max = Viewport.CANVAS_HEIGHT - (Constants.PIPE_GAP / 2);

//   return min + Math.random() * (max - min);                 //returns random position which stays on screen & bird can fly through
// };

// //returns state with new pipe along with old pipes
// const generatePipe = (s: State): State => {

//   const newPipe: Pipe = {
//     id: s.nextPipe,
//     frame: s.scrollX + Viewport.CANVAS_WIDTH + Constants.PIPE_WIDTH, //guarantees new pipe spawns at right edge
//     gapY: pipeGap()
//   };

//   return {
//     ...s,
//     pipes: s.pipes.concat(newPipe),
//     nextPipe: s.nextPipe + 1,               //increment id
//     nextPipeX: s.nextPipeX + Constants.PIPE_SPACE       //guarantees next spawn is one space later
//   };
// };

//helper shape type for rectangles
type Rect = Readonly<{ x:number; y:number; width:number; height:number }>;

//returns T if rectangles overlap
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x &&a.y < b.y + b.height && a.y + a.height > b.y;

//takes pipe, calculates two rectangles that make up pipe
const pipeRects = (p: Pipe): { top: Rect; bottom: Rect } => {
    const topHeight    = p.gapY - p.gapHeight / 2;              //uses gapHeight instead of constant value (can have diff size based off schedule)
    const bottomY      = p.gapY + p.gapHeight / 2;
    const bottomHeight = Viewport.CANVAS_HEIGHT - bottomY;

  return {      //returns rectangles
    top:    { x: p.frame, y: 0, width: Constants.PIPE_WIDTH, height: topHeight },
    bottom: { x: p.frame, y: bottomY, width: Constants.PIPE_WIDTH, height: bottomHeight },
  };
};

//turns csv rows into type ScheduleItem- entire function was generated using ChatGPT
const csvParser = (csv: string): ReadonlyArray<ScheduleItem> => {
  const [header, ...rows] = csv.trim().split(/\r?\n/);              
  return rows
    .map(r => r.split(",").map(s => s.trim()))
    .filter(cols => cols.length >= 3)
    .map(([gap_y, gap_height, time]) => ({
      appearTime: parseFloat(time) * 1000,
      gapY: parseFloat(gap_y) * Viewport.CANVAS_HEIGHT,
      gapHeight: parseFloat(gap_height) * Viewport.CANVAS_HEIGHT,
    }));
};

//prevents bird moving outside of screen
const clamp = (x: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, x));

//random number generator
const randomNum = (lo: number, hi: number) =>
    lo + Math.random() * (hi - lo);

//determines which side the bird hit
const collisionType = (bird: Rect, pipes: ReadonlyArray<Pipe>): "TOP" | "BOTTOM" | "NONE" => {
    const topScreen = bird.y <= 0;      //T if bird hit top of frame

    const bottomScreen = bird.y + bird.height >= Viewport.CANVAS_HEIGHT;        //T if bird hit bottom of frame

    const anyTopPipeHit = pipes             //checks if bird hit top half of any pipe
      .map(pipeRects)                       //converts into two rectangles
      .some(({ top }) => overlap(bird, top));       //checks if bird overlaps with one of those rects

    const anyBottomPipeHit = pipes          //checks if bird hit bottom half of any pipe
      .map(pipeRects)                       //converts into two rectangles
      .some(({ bottom }) => overlap(bird, bottom)); //checks if bird overlaps with one of those rects

    return topScreen || anyTopPipeHit       //if bird hit top screen or top of pipe
    ? "TOP"
    : bottomScreen || anyBottomPipeHit      //if bird hit bottom screen or top of pipe
    ? "BOTTOM"  
    : "NONE";                                   
};

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
// Proceed one time step  ← REPLACE entire tick()
const tick = (s: State) => {
    const elapsedMsNext = s.elapsedMs + Constants.TICK_RATE_MS;         //adds tick to elapsed time

    const due = s.pending.filter(it => it.appearTime > s.elapsedMs && it.appearTime <= elapsedMsNext);  //selects pipes with appearTime between previous and current tick from pending pipes

    const pendingAfter = s.pending.filter(it => it.appearTime > elapsedMsNext);     //filters schedule to keep ONLY pipes that appear after current tick

    const scrollPerMs = Constants.SCROLL / Constants.TICK_RATE_MS;      //pixels per tick -> pixels per ms (pipe scheduling uses ms not ticks)

    const newPipes: ReadonlyArray<Pipe> =               //create new pipe objects for schedules pipes in due
        due.map((curr_item, i) => ({
            id: s.nextPipe + i,
            frame: (scrollPerMs * curr_item.appearTime) + Viewport.CANVAS_WIDTH + Constants.PIPE_WIDTH,
            gapY: curr_item.gapY,
            gapHeight: curr_item.gapHeight,
        }));

    //calculate bird physics
    const velocity = s.birdVelocity + Constants.GRAVITY;
    const Y = s.birdY + velocity;
    const maxX = (Viewport.CANVAS_WIDTH - Birb.WIDTH) / 2;
    const nextX = Math.min(maxX, s.birdX + Constants.BIRD_X);

    //Merges list of already spawned pipes with pipes spawned in curr tick, removes old ones (only keeps relevant pipes)
    const inFramePipes = s.pipes
        .concat(newPipes)
        .filter(p => p.frame + Constants.PIPE_WIDTH >= s.scrollX);

    const birdFrameX = nextX + s.scrollX;               //gives frame position of bird

    const birdRect: Rect = { x: birdFrameX, y: Y, width: Birb.WIDTH, height: Birb.HEIGHT };     ////bird's rectangle in the game
           
    const pipeHit = collisionType(birdRect, inFramePipes);           //checks to see collision type 
        
    //top and bottom screen checks
    const topScreen = Y <= 0;
    const bottomScreen = Y + Birb.HEIGHT >= Viewport.CANVAS_HEIGHT;

    const birdFrameXPrev = s.birdX + s.scrollX;                         //calculates bird X position BEFORE tick updates
    const birdFrameXNext = nextX + (s.scrollX + Constants.SCROLL);      //calculates next bird x position

    //checks if bird has passed
    const newlyPassed =
      inFramePipes
        .map(p => p.frame + Constants.PIPE_WIDTH)
        .filter(rightEdge => rightEdge > birdFrameXPrev && rightEdge <= birdFrameXNext)
        .length;

    const canTakeHit = s.hitCooldown <= 0;      //activates cooldown to prevent losing multiple lives from one hit
    const anyHit = pipeHit !== "NONE" || topScreen || bottomScreen;     //true if bird hit pipe or top or bottom

    //calculates velocity after tick based off hit
    const bounceVel =
      topScreen || pipeHit === "TOP"    ?  randomNum(4, 10)  :
      bottomScreen || pipeHit === "BOTTOM" ? -randomNum(4, 10) :
      velocity;

    const scoreAfter = !anyHit ? s.score + newlyPassed : s.score;   //if hit, don't award point this tick (avoids doubling up), if no hit, increase by newlypassed
    const boundedY =
      topScreen    ? 0 :        //at top force y = 0
      bottomScreen ? Viewport.CANVAS_HEIGHT - Birb.HEIGHT :     //at bottom force y = bottom edge
                     Y;

    
    //takes away life                 
    const livesAfter =
      anyHit && canTakeHit ? Math.max(0, s.birdLives - 1) : s.birdLives;

    //if hit happened, reset cooldown to 6 ticks, else reduce by 1
      const hitCooldownAfter =
      anyHit && canTakeHit ? 6 : Math.max(0, s.hitCooldown - 1);

    //win when all scheduled pipes are passed
    const win = scoreAfter >= s.totalPipes;

    //if no lives, game is over
    const gameEndNow = livesAfter <= 0 || win;

    return {
      ...s,
      elapsedMs: elapsedMsNext,
      nextPipe: s.nextPipe + newPipes.length,    //increase id counter
      birdVelocity: bounceVel,
      birdY: clamp(boundedY, 0, Viewport.CANVAS_HEIGHT - Birb.HEIGHT),
      birdX: nextX,                             // ← apply horizontal motion
      scrollX: s.scrollX + Constants.SCROLL,    //each tick, frame moves rightward by scroll value
      pipes: inFramePipes,                      //pipes not in frame are forgotten
      birdLives: livesAfter,                    //lives in next state
      hitCooldown: hitCooldownAfter,            //hit cooldown in next state
      gameEnd: gameEndNow || s.gameEnd,         //T if game ended
      score: scoreAfter,                        //score after this tick
      pending: pendingAfter,
  };
};


// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const container = document.querySelector("#main") as HTMLElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    //create frame group- everything that should scroll is withint his group
    const frame = createSvgElement(svg.namespaceURI, "g", { id: "frame" });
    svg.appendChild(frame);                 //sets frame into svg 

    //birdImg moved outside of return(s) function so we don't duplicate in each tick
        const birdImg = createSvgElement(svg.namespaceURI, "image", {
            href: "assets/birb.png",
            x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
            y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
        });
        svg.appendChild(birdImg);         //birdImg attached to SVG- stops bird from going out of frame        

        frame.appendChild(createSvgElement(svg.namespaceURI, "g", { id: "pipes" }));


    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {

        frame.setAttribute("transform", `translate(${-s.scrollX}, 0)`);     //transform updates all children at once, shifts co-ordinates to move to the right (neg moves right)

        //pipes move into return function- redraw all the pipes in each state
        const oldPipes = frame.querySelector("#pipes");             //looks inside SVG group to grab all pipes in current (old) frame 
                       
        const newPipes = createSvgElement(svg.namespaceURI, "g", { id: "pipes" });      //creates fresh empty group


        s.pipes.flatMap(p => {

            //sizes for pipe shape (two rectangles)
            const topHeight   = p.gapY - p.gapHeight / 2;       //pipe shape based off csv- not constant
            const bottomY     = p.gapY + p.gapHeight / 2;
            const bottomHeight = Viewport.CANVAS_HEIGHT - bottomY;

            // Top pipe
            const pipeTop = createSvgElement(svg.namespaceURI, "rect", {
                x: `${p.frame}`,
                y: '0',
                width: `${Constants.PIPE_WIDTH}`,
                height:`${topHeight}`,
                fill: "green",
            });

            // Bottom pipe
            const pipeBottom = createSvgElement(svg.namespaceURI, "rect", {
                x: `${p.frame}`,
                y: `${bottomY}`,
                width: `${Constants.PIPE_WIDTH}`,
                height: `${bottomHeight}`,
                fill: "green",
            });

            return [pipeTop, pipeBottom]        //returns the two SVG elements that make up pipe
        })
        .forEach(elem => newPipes.appendChild(elem));   //takes array of rectangles and appends to new group

        oldPipes && frame.removeChild(oldPipes);        //removes old pipes from the frame

        frame.appendChild(newPipes);                //appends new pipes into frame


        birdImg.setAttribute("x", `${s.birdX}`);        // each tick updates x position
        birdImg.setAttribute("y", `${s.birdY}`);        //in return(s) because each tick should update the existing image's y position
        

        livesText.innerText = `${s.birdLives}`;         //displays text for amount of bird lives

        scoreText.innerText = `${s.score}`;             //displays text for player score

        if (s.gameEnd) {show(gameOver);}                 //shows game over message 
    };
};

export const state$ = (csvContents: string): Observable<State> => {
    /** User input */
    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) => key$.pipe(filter(({ code }) => code === keyCode));

    //build schedule from csv file
    const schedule: ReadonlyArray<ScheduleItem> = csvParser(csvContents);
    const initialState = InitialState(schedule);

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(map(() => (s: State): State => tick(s)));

    const flap$ = fromKey("Space").pipe(            //listens to spacebar   
        map(() => (s: State): State => ({           //transforms into reducer function
        ...s,                                       //copies current state
        birdVelocity: -Constants.FLAP,              //sets upward velocity (negative gravity since we want to move upward)
        }))
    );

    const reducers$: Observable<(s: State) => State> =          //declare observable to take state and return a state
        new Observable(subscriber => {
        const subscribers = [tick$, flap$].map(src => src.subscribe(subscriber));       //for each reducer function, subscribe to it and send what it emits to its subscriber
        return () => subscribers.forEach(s => s.unsubscribe());                         //both reducer functions ignored when reducer$ is unsubscribed 
        });

    return reducers$.pipe(scan((state, reducer) => reducer(state), initialState));          //transform stream of reducer functions by applying them, producing next state, outputting state values 
};




// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            click$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
