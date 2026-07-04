import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Sky } from '@react-three/drei';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'framer-motion';

const MAP_SIZE = 60;
const INITIAL_TREES = 30;
const INITIAL_ROCKS = 20;
const ENEMY_SPEED = 3;
const PLAYER_SPEED = 6;
const HOUSE_COST = 5;

// Types
type Tool = 'axe' | 'pickaxe' | 'wall' | 'campfire' | 'door' | 'car' | 'tent';
type GameStatus = 'menu' | 'playing' | 'gameover' | 'win' | 'paused' | 'credits';

interface Entity { id: number; pos: THREE.Vector3; hp: number; type: string }
interface Door { id: number; pos: THREE.Vector3; isOpen: boolean; isRotated: boolean }
interface Campfire { id: number; pos: THREE.Vector3 }
interface Car { id: number; pos: THREE.Vector3 }
interface Tent { id: number; pos: THREE.Vector3 }
interface HousePart { id: number; pos: THREE.Vector3; isRotated: boolean }

class SoundManager {
  ctx: AudioContext | null = null;
  ambientFilter: BiquadFilterNode | null = null;
  ambientGain: GainNode | null = null;
  cityAudio: HTMLAudioElement | null = null;
  cityPlaying: boolean = false;
  nightAudio: HTMLAudioElement | null = null;
  nightPlaying: boolean = false;
  masterVolume: number = 1.0;

  init() {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.startAmbient();
      
      this.cityAudio = new Audio('https://www.sonidosmp3gratis.com/sounds/ciudad_3.mp3');
      this.cityAudio.loop = true;
      this.cityAudio.volume = 0.4 * this.masterVolume;
      
      this.nightAudio = new Audio('https://www.sonidosmp3gratis.com/sounds/ambient_45.mp3');
      this.nightAudio.loop = true;
      this.nightAudio.volume = 0.4 * this.masterVolume;
  }

  setVolume(vol: number) {
      this.masterVolume = Math.max(0, Math.min(1, vol));
      if (this.cityAudio) this.cityAudio.volume = 0.4 * this.masterVolume;
      if (this.nightAudio) this.nightAudio.volume = 0.4 * this.masterVolume;
      // Re-trigger ambient mode to adjust gain
      this.setAmbientMode(gs.timeInDay >= 420);
  }

  startAmbient() {
      if (!this.ctx) return;
      const bufferSize = this.ctx.sampleRate * 2;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
      }
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      
      this.ambientFilter = this.ctx.createBiquadFilter();
      this.ambientFilter.type = 'lowpass';
      this.ambientFilter.frequency.value = 800; // Day wind
      
      this.ambientGain = this.ctx.createGain();
      this.ambientGain.gain.value = 0.05 * this.masterVolume; // Base volume
      
      noise.connect(this.ambientFilter);
      this.ambientFilter.connect(this.ambientGain);
      this.ambientGain.connect(this.ctx.destination);
      noise.start();
  }

  setAmbientMode(isNight: boolean) {
      if (!this.ctx || !this.ambientFilter || !this.ambientGain) return;
      const targetFreq = isNight ? 200 : 800;
      const targetGain = (isNight ? 0.08 : 0.03) * this.masterVolume;
      this.ambientFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 2);
      this.ambientGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 2);
      
      if (this.cityAudio && this.nightAudio) {
          if (isNight) {
              if (this.cityPlaying) {
                 this.cityAudio.pause();
                 this.cityPlaying = false;
              }
              if (!this.nightPlaying) {
                 this.nightAudio.play().catch(e => console.error("Audio play error", e));
                 this.nightPlaying = true;
              }
          } else {
              if (!this.cityPlaying) {
                 this.cityAudio.play().catch(e => console.error("Audio play error", e));
                 this.cityPlaying = true;
              }
              if (this.nightPlaying) {
                 this.nightAudio.pause();
                 this.nightPlaying = false;
              }
          }
      }
  }

  playChop() {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(150, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.1);
  }

  playMine() {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.1);
  }
}
const audio = new SoundManager();

// Utils
const randPos = (minR: number, maxR: number) => {
  const r = minR + (maxR - minR) * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  return new THREE.Vector3(r * Math.cos(theta), 0, r * Math.sin(theta));
};

// Global Game State (Ref-based for 3D performance)
const gs = {
  pos: new THREE.Vector3(0, 0, 0),
  health: 100,
  wood: 0,
  stone: 0,
  houseParts: [] as HousePart[],
  campfires: [] as Campfire[],
  doors: [] as Door[],
  cars: [] as Car[],
  tents: [] as Tent[],
  trees: [] as Entity[],
  rocks: [] as Entity[],
  enemies: [] as Entity[],
  keys: { w: false, a: false, s: false, d: false },
  action: false,
  rightAction: false,
  build: false,
  buildRotation: false,
  pointerPos: new THREE.Vector3(),
  tool: 'axe' as Tool,
  status: 'menu' as GameStatus,
  lastEnemySpawn: 0,
  timeInDay: 0, // max 600s
  daysLeft: 33,
  enemySpawnTimer: 30,
  ufoTimer: 0,
};

// Utils
const checkCollision = (newPos: THREE.Vector3, radius = 1) => {
  const check = (arr: { pos: THREE.Vector3 }[], dist: number) => 
    arr.some(item => item.pos.distanceTo(newPos) < dist);
    
  if (check(gs.trees, 1.5)) return true;
  if (check(gs.rocks, 1.5)) return true;
  if (check(gs.houseParts, 2)) return true;
  if (check(gs.campfires, 1.5)) return true;
  if (check(gs.cars, 2)) return true;
  if (check(gs.tents, 2.5)) return true;
  if (gs.doors.some(d => !d.isOpen && d.pos.distanceTo(newPos) < 2)) return true;
  if (check(gs.enemies, 1.5)) return true;
  return false;
};

// --- 3D COMPONENTS ---

const Lighting = () => {
  const dirRef = useRef<THREE.DirectionalLight>(null);
  const ambRef = useRef<THREE.AmbientLight>(null);
  
  useFrame((_, delta) => {
    const isNight = gs.timeInDay >= 420;
    const targetDir = isNight ? 0.2 : 1.5;
    const targetAmb = isNight ? 0.2 : 0.4;
    
    if (dirRef.current) dirRef.current.intensity += (targetDir - dirRef.current.intensity) * delta;
    if (ambRef.current) ambRef.current.intensity += (targetAmb - ambRef.current.intensity) * delta;
  });

  return (
    <>
      <ambientLight ref={ambRef} intensity={0.4} />
      <directionalLight ref={dirRef} castShadow position={[50, 50, 50]} intensity={1.5} shadow-mapSize={[1024, 1024]}>
        <orthographicCamera attach="shadow-camera" args={[-70, 70, 70, -70]} />
      </directionalLight>
    </>
  );
};

const Player = () => {
  const ref = useRef<THREE.Group>(null);
  const { camera, raycaster, pointer } = useThree();
  const currentActionTime = useRef(0);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);

  useFrame((state, delta) => {
    if (gs.status === 'menu' || gs.status === 'paused' || gs.status === 'gameover' || gs.status === 'credits') return;
    if (gs.status === 'win') {
      gs.ufoTimer += delta;
      if (gs.ufoTimer < 5) {
        gs.pos.y += delta * 3; // Float upwards
        if (ref.current) ref.current.position.copy(gs.pos);
        camera.position.lerp(gs.pos.clone().add(new THREE.Vector3(0, 5, -15)), 0.05);
        camera.lookAt(gs.pos);
      } else {
        gs.pos.y = 20; // Inside UFO
        if (ref.current) ref.current.position.copy(gs.pos);
        camera.position.set(gs.pos.x, 21.5, gs.pos.z - 6);
        camera.lookAt(gs.pos.x, 20.5, gs.pos.z);
      }
      return;
    }

    if (gs.status !== 'playing') return;

    // Track pointer on ground
    raycaster.setFromCamera(pointer, camera);
    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, target);
    if (target) {
      gs.pointerPos.copy(target);
    }

    // Movement (Inverted per prompt: W=+Z, S=-Z, A=+X, D=-X)
    let dx = 0; let dz = 0;
    if (gs.keys.w) dz += 1;
    if (gs.keys.s) dz -= 1;
    if (gs.keys.a) dx += 1;
    if (gs.keys.d) dx -= 1;

    if (dx !== 0 || dz !== 0) {
      const dir = new THREE.Vector3(dx, 0, dz).normalize();
      const nextPos = gs.pos.clone().add(dir.multiplyScalar(PLAYER_SPEED * delta));
      if (!checkCollision(nextPos)) {
        gs.pos.copy(nextPos);
      }
    }

    if (ref.current) {
      ref.current.position.lerp(gs.pos, 0.2);
    }

    // Camera follow
    if (gs.status !== 'win') {
      const idealCamPos = gs.pos.clone().add(new THREE.Vector3(0, 10, -15));
      camera.position.lerp(idealCamPos, 0.1);
      camera.lookAt(gs.pos);
    }

    // Actions & Attacking / Building
    if (gs.action && state.clock.elapsedTime - currentActionTime.current > 0.3) {
      currentActionTime.current = state.clock.elapsedTime;
      
      const hitRadius = 3;

      if (['wall', 'campfire', 'door', 'car', 'tent'].includes(gs.tool)) {
         const dist = gs.pointerPos.distanceTo(gs.pos);
         if (dist < 10) { // Max build reach
            const rot = gs.buildRotation;
            if (gs.tool === 'wall' && gs.wood >= HOUSE_COST && !checkCollision(gs.pointerPos, 2)) {
               audio.playChop();
               gs.wood -= HOUSE_COST;
               gs.houseParts.push({ id: Math.random(), pos: gs.pointerPos.clone(), isRotated: rot });
            } else if (gs.tool === 'campfire' && gs.wood >= 4 && gs.stone >= 2 && !checkCollision(gs.pointerPos, 1.5)) {
               audio.playMine();
               gs.wood -= 4; gs.stone -= 2;
               gs.campfires.push({ id: Math.random(), pos: gs.pointerPos.clone() });
            } else if (gs.tool === 'door' && gs.wood >= 4 && !checkCollision(gs.pointerPos, 2)) {
               audio.playChop();
               gs.wood -= 4;
               gs.doors.push({ id: Math.random(), pos: gs.pointerPos.clone(), isOpen: false, isRotated: rot });
            } else if (gs.tool === 'car' && gs.wood >= 10 && !checkCollision(gs.pointerPos, 2.5)) {
               audio.playMine();
               gs.wood -= 10;
               gs.cars.push({ id: Math.random(), pos: gs.pointerPos.clone() });
            } else if (gs.tool === 'tent' && gs.wood >= 6 && !checkCollision(gs.pointerPos, 3)) {
               audio.playChop();
               gs.wood -= 6;
               gs.tents.push({ id: Math.random(), pos: gs.pointerPos.clone() });
            }
         }
         return;
      }

      // Hit Door (Toggle)
      const hitDoor = gs.doors.find(d => d.pos.distanceTo(gs.pos) < hitRadius);
      if (hitDoor) {
        hitDoor.isOpen = !hitDoor.isOpen;
        return;
      }
      
      // Hit Enemies
      const hitEnemy = gs.enemies.find(e => e.pos.distanceTo(gs.pos) < hitRadius);
      if (hitEnemy) {
        audio.playChop();
        hitEnemy.hp -= 34; // 3 hits to kill
        if (hitEnemy.hp <= 0) gs.enemies = gs.enemies.filter(e => e.id !== hitEnemy.id);
        return;
      }
      
      // Chop Trees
      if (gs.tool === 'axe') {
        const hitTree = gs.trees.find(t => t.pos.distanceTo(gs.pos) < hitRadius);
        if (hitTree) {
          audio.playChop();
          hitTree.hp -= 50; // 2 hits to chop
          if (hitTree.hp <= 0) {
            gs.trees = gs.trees.filter(t => t.id !== hitTree.id);
            gs.wood += 2;
          }
        }
      }

      // Mine Rocks
      if (gs.tool === 'pickaxe') {
        const hitRock = gs.rocks.find(r => r.pos.distanceTo(gs.pos) < hitRadius);
        if (hitRock) {
          audio.playMine();
          hitRock.hp -= 34;
          if (hitRock.hp <= 0) {
            gs.rocks = gs.rocks.filter(r => r.id !== hitRock.id);
            gs.stone += 2;
          }
        }
      }
    }

    if (gs.rightAction && state.clock.elapsedTime - currentActionTime.current > 0.3) {
      currentActionTime.current = state.clock.elapsedTime;
      const hitRadius = 3;

      let destroyed = false;

      const hitWall = gs.houseParts.find(p => p.pos.distanceTo(gs.pos) < hitRadius);
      if (hitWall) {
        audio.playChop();
        gs.houseParts = gs.houseParts.filter(p => p.id !== hitWall.id);
        gs.wood += HOUSE_COST;
        destroyed = true;
      }
      
      if (!destroyed) {
         const hitCampfire = gs.campfires.find(c => c.pos.distanceTo(gs.pos) < hitRadius);
         if (hitCampfire) {
           audio.playChop();
           gs.campfires = gs.campfires.filter(c => c.id !== hitCampfire.id);
           gs.wood += 4; gs.stone += 2;
           destroyed = true;
         }
      }
      if (!destroyed) {
         const hitDoor = gs.doors.find(d => d.pos.distanceTo(gs.pos) < hitRadius);
         if (hitDoor) {
           audio.playChop();
           gs.doors = gs.doors.filter(d => d.id !== hitDoor.id);
           gs.wood += 4;
           destroyed = true;
         }
      }
      if (!destroyed) {
         const hitCar = gs.cars.find(c => c.pos.distanceTo(gs.pos) < hitRadius);
         if (hitCar) {
           audio.playMine();
           gs.cars = gs.cars.filter(c => c.id !== hitCar.id);
           gs.wood += 10;
           destroyed = true;
         }
      }
      if (!destroyed) {
         const hitTent = gs.tents.find(t => t.pos.distanceTo(gs.pos) < hitRadius);
         if (hitTent) {
           audio.playChop();
           gs.tents = gs.tents.filter(t => t.id !== hitTent.id);
           gs.wood += 6;
           destroyed = true;
         }
      }
      
      // If we didn't destroy anything and had a build tool, just cancel it
      if (!destroyed && ['wall', 'campfire', 'door', 'car', 'tent'].includes(gs.tool)) {
         gs.tool = 'axe';
      }
    }
  });

  return (
    <>
      <group ref={ref}>
        <mesh position={[0, 1, 0]} castShadow>
          <capsuleGeometry args={[0.5, 1]} />
          <meshStandardMaterial color="#1E88E5" />
        </mesh>
      </group>

      {/* UFO Scene */}
      {gs.status === 'win' && (
        <group position={[gs.pos.x, 20, gs.pos.z]}>
          {gs.ufoTimer < 5 ? (
            <>
              {/* Outside UFO */}
              <mesh position={[0, -1, 0]}>
                <cylinderGeometry args={[6, 2, 2, 32]} />
                <meshStandardMaterial color="#374151" metalness={0.8} />
              </mesh>
              <mesh position={[0, 0, 0]}>
                <sphereGeometry args={[2.5, 16, 16]} />
                <meshStandardMaterial color="#10B981" transparent opacity={0.6} />
              </mesh>
              {/* Abduction Beam */}
              <mesh position={[0, -6 - (gs.pos.y * 0.5), 0]}>
                <cylinderGeometry args={[2, 5, 20 + gs.pos.y, 32]} />
                <meshBasicMaterial color="#34D399" transparent opacity={0.3} />
              </mesh>
              <pointLight color="#10B981" intensity={5} distance={30} position={[0, -2, 0]} />
            </>
          ) : (
            <>
              {/* Inside UFO Room */}
              <mesh position={[0, -0.5, 0]} receiveShadow>
                <boxGeometry args={[15, 1, 15]} />
                <meshStandardMaterial color="#111827" metalness={0.9} roughness={0.2} />
              </mesh>
              <mesh position={[0, 5, 0]}>
                <boxGeometry args={[15, 1, 15]} />
                <meshStandardMaterial color="#111827" />
              </mesh>
              
              {/* Aliens (identical to player) */}
              <mesh position={[-2, 1, 2]} rotation={[0, Math.PI/4, 0]} castShadow><capsuleGeometry args={[0.5, 1]}/><meshStandardMaterial color="#1E88E5"/></mesh>
              <mesh position={[2, 1, 2]} rotation={[0, -Math.PI/4, 0]} castShadow><capsuleGeometry args={[0.5, 1]}/><meshStandardMaterial color="#1E88E5"/></mesh>
              <mesh position={[0, 1, 3]} rotation={[0, 0, 0]} castShadow><capsuleGeometry args={[0.5, 1]}/><meshStandardMaterial color="#1E88E5"/></mesh>
              
              <pointLight color="#34D399" intensity={2} position={[0, 3, 0]} castShadow />
              <pointLight color="#fff" intensity={0.5} position={[0, 2, 2]} />
            </>
          )}
        </group>
      )}
    </>
  );
};

const BuildPreview = ({ tool, wood, stone }: { tool: string; wood: number; stone: number }) => {
  const ref = useRef<THREE.Group>(null);
  
  useFrame(() => {
    if (['wall', 'campfire', 'door', 'car', 'tent'].includes(gs.tool) && ref.current) {
      ref.current.position.lerp(gs.pointerPos, 0.4);
      
      const rot = gs.buildRotation;
      if (['wall', 'door'].includes(gs.tool)) {
         ref.current.rotation.set(0, rot ? Math.PI / 2 : 0, 0);
      } else {
         ref.current.rotation.set(0, 0, 0);
      }

      let isValid = false;
      if (gs.tool === 'wall' && gs.wood >= HOUSE_COST && !checkCollision(gs.pointerPos, 2)) isValid = true;
      else if (gs.tool === 'campfire' && gs.wood >= 4 && gs.stone >= 2 && !checkCollision(gs.pointerPos, 1.5)) isValid = true;
      else if (gs.tool === 'door' && gs.wood >= 4 && !checkCollision(gs.pointerPos, 2)) isValid = true;
      else if (gs.tool === 'car' && gs.wood >= 10 && !checkCollision(gs.pointerPos, 2.5)) isValid = true;
      else if (gs.tool === 'tent' && gs.wood >= 6 && !checkCollision(gs.pointerPos, 3)) isValid = true;

      if (gs.pointerPos.distanceTo(gs.pos) >= 10) isValid = false;

      const color = isValid ? 0x00ff00 : 0xff0000;
      ref.current.children.forEach((child: any) => {
        if (child.material) {
          child.material.color.setHex(color);
        }
        child.children?.forEach((subchild: any) => {
           if (subchild.material) subchild.material.color.setHex(color);
        });
      });
    }
  });

  if (!['wall', 'campfire', 'door', 'car', 'tent'].includes(tool)) return null;

  return (
    <group ref={ref}>
      {tool === 'wall' && (
        <mesh position={[0, 1.5, 0]}>
          <boxGeometry args={[3, 3, 0.4]} />
          <meshBasicMaterial transparent opacity={0.4} color="lime" />
        </mesh>
      )}
      {tool === 'campfire' && (
        <mesh position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.6, 0.8, 0.3]} />
          <meshBasicMaterial transparent opacity={0.4} color="lime" />
        </mesh>
      )}
      {tool === 'door' && (
        <mesh position={[0, 1, 0]}>
          <boxGeometry args={[2, 2, 0.4]} />
          <meshBasicMaterial transparent opacity={0.4} color="lime" />
        </mesh>
      )}
      {tool === 'car' && (
        <group position={[0, 1, 0]}>
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[2, 1, 4]} />
            <meshBasicMaterial transparent opacity={0.4} color="lime" />
          </mesh>
          <mesh position={[-1, 0, -1.5]} rotation={[0, 0, Math.PI / 2]}>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshBasicMaterial transparent opacity={0.4} color="lime" />
          </mesh>
          <mesh position={[1, 0, -1.5]} rotation={[0, 0, Math.PI / 2]}>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshBasicMaterial transparent opacity={0.4} color="lime" />
          </mesh>
          <mesh position={[-1, 0, 1.5]} rotation={[0, 0, Math.PI / 2]}>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshBasicMaterial transparent opacity={0.4} color="lime" />
          </mesh>
          <mesh position={[1, 0, 1.5]} rotation={[0, 0, Math.PI / 2]}>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshBasicMaterial transparent opacity={0.4} color="lime" />
          </mesh>
        </group>
      )}
      {tool === 'tent' && (
        <mesh position={[0, 1.5, 0]}>
           <coneGeometry args={[2, 3, 4]} />
           <meshBasicMaterial transparent opacity={0.4} color="lime" />
        </mesh>
      )}
    </group>
  );
};

const EntitiesManager = ({ setTriggerUI }: { setTriggerUI: any }) => {
  useFrame((state, delta) => {
    if (gs.status !== 'playing') return;

    // Time & Day Cycle
    gs.timeInDay += delta;
    if (gs.timeInDay >= 600) {
      gs.timeInDay -= 600;
      gs.daysLeft--;
      if (gs.daysLeft <= 0) {
        gs.status = 'win';
        setTriggerUI(Date.now());
        return;
      }
    }
    const isNight = gs.timeInDay >= 420; // 7 mins day, 3 mins night
    
    audio.setAmbientMode(isNight);

    // Enemy AI & Spawning
    gs.enemySpawnTimer -= delta;
    if (gs.enemySpawnTimer <= 0) {
      // Spawn slightly further away so they don't pop in on screen
      gs.enemies.push({ id: Math.random(), pos: randPos(25, 45), hp: 100, type: 'enemy' });
      
      if (isNight) {
        // Night: spawn every 15-25s (increase appearance)
        gs.enemySpawnTimer = 15 + Math.random() * 10;
      } else {
        // Day: spawn every 40-70s (irregular, min > 30s as per day condition)
        gs.enemySpawnTimer = 40 + Math.random() * 30;
      }
    }

    let damaged = false;
    gs.enemies.forEach(enemy => {
      const dir = gs.pos.clone().sub(enemy.pos).normalize();
      const nextPos = enemy.pos.clone().add(dir.multiplyScalar(ENEMY_SPEED * delta));
      
      const dist = enemy.pos.distanceTo(gs.pos);
      if (dist < 1.5) {
        gs.health -= 15 * delta;
        damaged = true;
      } else {
        // Prevent enemy overlap with each other and environment
        let collision = false;
        if (checkCollision(nextPos, 1)) {
          // simple avoid: don't move
          collision = true; 
        }
        
        // Very basic simple check so they don't clip trees (checkCollision handles this mostly)
        if (!collision) enemy.pos.copy(nextPos);
      }
    });

    if (damaged) setTriggerUI(Date.now());
  });

  return (
    <>
      {gs.trees.map((t: any) => (
        <group key={`t-${t.id}`} position={t.pos}>
          {t.type === 'pine' ? (
              <>
                 <mesh position={[0, 1.5, 0]} castShadow>
                   <cylinderGeometry args={[0.3, 0.4, 3]} />
                   <meshStandardMaterial color="#3E2723" />
                 </mesh>
                 <mesh position={[0, 3.5, 0]} castShadow>
                   <coneGeometry args={[2, 4]} />
                   <meshStandardMaterial color="#1B5E20" />
                 </mesh>
              </>
          ) : (
              <>
                 <mesh position={[0, 1.5, 0]} castShadow>
                   <cylinderGeometry args={[0.4, 0.5, 3]} />
                   <meshStandardMaterial color="#5D4037" />
                 </mesh>
                 <mesh position={[0, 4, 0]} castShadow>
                   <dodecahedronGeometry args={[2.5]} />
                   <meshStandardMaterial color="#4CAF50" />
                 </mesh>
              </>
          )}
        </group>
      ))}
      {gs.rocks.map(r => (
        <mesh key={`r-${r.id}`} position={r.pos} castShadow>
          <dodecahedronGeometry args={[1.2]} />
          <meshStandardMaterial color="#757575" />
        </mesh>
      ))}
      {gs.enemies.map(e => (
        <mesh key={`e-${e.id}`} position={[e.pos.x, 1, e.pos.z]} castShadow>
          <boxGeometry args={[1.2, 2, 1.2]} />
          <meshStandardMaterial color="#E53935" />
        </mesh>
      ))}
      {gs.houseParts.map((p, i) => (
        <mesh key={`h-${p.id || i}`} position={[p.pos?.x ?? p.x, 1.5, p.pos?.z ?? p.z]} rotation={[0, p.isRotated ? Math.PI / 2 : 0, 0]} castShadow>
          <boxGeometry args={[3, 3, 0.4]} />
          <meshStandardMaterial color="#FFB300" />
        </mesh>
      ))}
      {gs.campfires.map(c => (
        <group key={`c-${c.id}`} position={[c.pos.x, 0.5, c.pos.z]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.6, 0.8, 0.3]} />
            <meshStandardMaterial color="#3E2723" />
          </mesh>
          <mesh position={[0, 0.5, 0]}>
            <coneGeometry args={[0.5, 1]} />
            <meshBasicMaterial color="#FF5722" />
          </mesh>
          <pointLight castShadow position={[0, 2, 0]} intensity={3} color="#FF9800" distance={20} />
        </group>
      ))}
      {gs.doors.map(d => (
        <mesh key={`d-${d.id}`} position={[d.pos.x, 1, d.pos.z]} rotation={[0, (d.isRotated ? Math.PI / 2 : 0) + (d.isOpen ? Math.PI / 2 : 0), 0]} castShadow>
          <boxGeometry args={[2, 2, 0.4]} />
          <meshStandardMaterial color="#795548" />
        </mesh>
      ))}
      {gs.cars.map(c => (
        <group key={`car-${c.id}`} position={[c.pos.x, c.pos.y + 1, c.pos.z]}>
          <mesh position={[0, 0.5, 0]} castShadow>
             <boxGeometry args={[2, 1, 4]} />
             <meshStandardMaterial color="#ef4444" metalness={0.6} />
          </mesh>
          <mesh position={[-1, 0, -1.5]} rotation={[0, 0, Math.PI / 2]} castShadow>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshStandardMaterial color="#1f2937" />
          </mesh>
          <mesh position={[1, 0, -1.5]} rotation={[0, 0, Math.PI / 2]} castShadow>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshStandardMaterial color="#1f2937" />
          </mesh>
          <mesh position={[-1, 0, 1.5]} rotation={[0, 0, Math.PI / 2]} castShadow>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshStandardMaterial color="#1f2937" />
          </mesh>
          <mesh position={[1, 0, 1.5]} rotation={[0, 0, Math.PI / 2]} castShadow>
             <cylinderGeometry args={[0.5, 0.5, 0.4]} />
             <meshStandardMaterial color="#1f2937" />
          </mesh>
        </group>
      ))}
      {gs.tents.map(t => (
        <mesh key={`tent-${t.id}`} position={[t.pos.x, t.pos.y + 1.5, t.pos.z]} castShadow receiveShadow>
           <coneGeometry args={[2, 3, 4]} />
           <meshStandardMaterial color="#22c55e" />
        </mesh>
      ))}
    </>
  );
};

export default function App() {
  const [uiState, setUiState] = useState({
    health: 100, wood: 0, stone: 0, house: 0, campfires: 0, doors: 0, tool: 'axe', status: 'menu', daysLeft: 33, isNight: false, ufoTimer: 0, timeInDay: 0, volume: 1.0
  });
  const [triggerUI, setTriggerUI] = useState(0);

  const initGame = useCallback((loadFromSave: boolean = false) => {
    audio.init();
    if (loadFromSave) {
        const saved = localStorage.getItem('game_save');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                gs.health = data.health; gs.wood = data.wood; gs.stone = data.stone; gs.timeInDay = data.timeInDay; gs.daysLeft = data.daysLeft; gs.enemySpawnTimer = data.enemySpawnTimer; gs.ufoTimer = data.ufoTimer;
                gs.pos.set(data.pos[0], data.pos[1], data.pos[2]);
                const vecMap = (arr: any[]) => arr.map((x: any) => ({...x, pos: new THREE.Vector3(x.pos[0], x.pos[1], x.pos[2])}));
                gs.trees = vecMap(data.trees);
                gs.rocks = vecMap(data.rocks);
                gs.houseParts = vecMap(data.houseParts);
                gs.campfires = vecMap(data.campfires);
                gs.doors = vecMap(data.doors);
                gs.cars = vecMap(data.cars);
                gs.tents = vecMap(data.tents);
                gs.enemies = vecMap(data.enemies);
                gs.tool = 'axe'; gs.status = 'playing';
                setTriggerUI(Date.now());
                return;
            } catch (e) {
                console.error("Failed to load save", e);
            }
        }
    }
    gs.health = 100; gs.wood = 0; gs.stone = 0; gs.houseParts = []; gs.campfires = []; gs.doors = []; gs.cars = []; gs.tents = [];
    gs.trees = [
        ...Array.from({ length: INITIAL_TREES }).map(() => ({ id: Math.random(), pos: randPos(5, MAP_SIZE * 0.4), hp: 100, type: 'tree' })),
        ...Array.from({ length: 150 }).map(() => ({ id: Math.random(), pos: randPos(MAP_SIZE * 0.4, MAP_SIZE), hp: 100, type: 'pine' }))
    ];
    gs.rocks = Array.from({ length: INITIAL_ROCKS }).map(() => ({ id: Math.random(), pos: randPos(5, MAP_SIZE * 0.4), hp: 100, type: 'rock' }));
    gs.enemies = [];
    gs.pos.set(0, 0, 0);
    gs.tool = 'axe';
    gs.status = 'playing';
    gs.lastEnemySpawn = 0;
    gs.timeInDay = 0;
    gs.daysLeft = 33;
    gs.enemySpawnTimer = 30;
    gs.ufoTimer = 0;
    setTriggerUI(Date.now());
  }, []);

  const saveGameAndLeave = useCallback(() => {
    try {
        const data = {
            health: gs.health, wood: gs.wood, stone: gs.stone,
            trees: gs.trees.map(t => ({...t, pos: [t.pos.x, t.pos.y, t.pos.z]})),
            rocks: gs.rocks.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            houseParts: gs.houseParts.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            campfires: gs.campfires.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            doors: gs.doors.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            cars: gs.cars.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            tents: gs.tents.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            enemies: gs.enemies.map(r => ({...r, pos: [r.pos.x, r.pos.y, r.pos.z]})),
            pos: [gs.pos.x, gs.pos.y, gs.pos.z],
            timeInDay: gs.timeInDay, daysLeft: gs.daysLeft, lastEnemySpawn: gs.lastEnemySpawn, enemySpawnTimer: gs.enemySpawnTimer, ufoTimer: gs.ufoTimer
        };
        localStorage.setItem('game_save', JSON.stringify(data));
        gs.status = 'menu';
        setTriggerUI(Date.now());
    } catch(e) { console.error(e) }
  }, []);

  const hasSave = !!localStorage.getItem('game_save');

  useEffect(() => {
    if (gs.health <= 0 && gs.status === 'playing') {
      gs.status = 'gameover';
      setTriggerUI(Date.now());
    }
  }, [triggerUI]);

  useEffect(() => {
    setUiState({
      health: gs.health, wood: gs.wood, stone: gs.stone, 
      house: gs.houseParts.length, campfires: gs.campfires.length, doors: gs.doors.length, 
      tool: gs.tool, status: gs.status, daysLeft: gs.daysLeft, isNight: gs.timeInDay >= 420, ufoTimer: gs.ufoTimer, timeInDay: gs.timeInDay, volume: audio.masterVolume
    });
  }, [triggerUI]);

  // UI polling loop (since we don't use React state for 3D state to save frames)
  useEffect(() => {
    const interval = setInterval(() => setTriggerUI(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);

  // Controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'p' || k === 'escape') {
         if (gs.status === 'playing') {
             gs.status = 'paused';
             gs.keys.w = false; gs.keys.a = false; gs.keys.s = false; gs.keys.d = false; gs.action = false; gs.rightAction = false;
         }
         else if (gs.status === 'paused') gs.status = 'playing';
         setTriggerUI(Date.now());
         return;
      }
      if (['w', 'a', 's', 'd'].includes(k)) gs.keys[k as 'w'|'a'|'s'|'d'] = true;
      if (k === '1') gs.tool = 'axe';
      if (k === '2') gs.tool = 'pickaxe';
      if (gs.status === 'playing') {
        if (k === 'e') {
           if (gs.tool === 'wall') gs.buildRotation = !gs.buildRotation;
           gs.tool = 'wall';
        }
        if (k === 'r') {
           if (gs.tool === 'campfire') gs.buildRotation = !gs.buildRotation;
           gs.tool = 'campfire';
        }
        if (k === 't') {
           if (gs.tool === 'door') gs.buildRotation = !gs.buildRotation;
           gs.tool = 'door';
        }
      }
      setTriggerUI(Date.now());
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(k)) gs.keys[k as 'w'|'a'|'s'|'d'] = false;
    };
    const handleMouseDn = (e: MouseEvent) => { 
      if (e.button === 0) gs.action = true;
      if (e.button === 2) gs.rightAction = true;
      setTriggerUI(Date.now());
    };
    const handleMouseUp = (e: MouseEvent) => { 
      if (e.button === 0) gs.action = false;
      if (e.button === 2) gs.rightAction = false;
    };
    const handleContext = (e: MouseEvent) => { 
      e.preventDefault(); 
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDn);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('contextmenu', handleContext);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDn);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('contextmenu', handleContext);
    };
  }, []);

  return (
    <div className="w-screen h-screen relative overflow-hidden font-sans bg-[#0a120a] flex flex-col select-none">
      <div className="absolute inset-0 z-0">
        <Canvas shadows={{ type: THREE.PCFShadowMap }} camera={{ position: [0, 10, -15], fov: 60 }}>
          <Sky sunPosition={uiState.isNight ? [100, -20, 100] : [100, 20, 100]} />
          <Lighting />
          
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[200, 200]} />
            <meshStandardMaterial color="#33691E" />
          </mesh>

          <BuildPreview tool={uiState.tool} wood={uiState.wood} stone={uiState.stone} />
          
          <Player />
          <EntitiesManager setTriggerUI={setTriggerUI} />
        </Canvas>
      </div>

      {/* Capa Superior de UI (HUD) */}
      <AnimatePresence>
        {uiState.status === 'playing' && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-10 p-8 flex flex-col justify-between pointer-events-none"
          >
            {/* Fila Superior: Estadísticas y Título */}
            <div className="flex justify-between items-start">
              {/* Vitalidad */}
              <div className="w-80 backdrop-blur-md bg-black/40 border border-white/10 rounded-2xl p-4">
                <div className="flex justify-between items-end mb-2">
                  <span className="text-xs uppercase tracking-widest text-emerald-400 font-bold">Vitalidad</span>
                  <span className="text-xl font-mono text-white">{Math.max(0, Math.floor(uiState.health))}%</span>
                </div>
                <div className="w-full h-3 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-red-500 to-emerald-500 transition-all duration-300 ease-out"
                    style={{ width: `${Math.max(0, uiState.health)}%` }} 
                  ></div>
                </div>
              </div>

              {/* Logo / Estado del Mundo */}
              <div className="text-center absolute left-1/2 -translate-x-1/2 top-6">
                <h1 className="text-2xl font-black text-white tracking-tighter uppercase leading-none">Solo<br/><span className="text-emerald-500">33</span></h1>
                <div className={`mt-2 inline-block px-3 py-1 ${uiState.isNight ? 'bg-indigo-900/50 border-indigo-500/50' : 'bg-white/5 border-white/10'} backdrop-blur-sm rounded-full border`}>
                  <span className={`text-[10px] uppercase ${uiState.isNight ? 'text-indigo-200' : 'text-emerald-200'} tracking-[0.2em] font-bold`}>
                     Faltan {uiState.daysLeft} Días — {uiState.isNight ? 'NOCHE' : 'DÍA'} ({Math.floor((uiState.isNight ? 600 - uiState.timeInDay : 420 - uiState.timeInDay) / 60)}:{Math.floor((uiState.isNight ? 600 - uiState.timeInDay : 420 - uiState.timeInDay) % 60).toString().padStart(2, '0')})
                  </span>
                </div>
              </div>

              <div className="w-80"></div>
            </div>

              {/* Fila Media: Espacio libre */}
              <div className="w-full h-full flex justify-end items-center px-4 py-8 pointer-events-none">
              </div>

            {/* Fila Inferior: Inventario y Herramientas */}
            <div className="flex justify-between items-end">
              {/* Controles / Guía */}
              <div className="w-64 space-y-2 pointer-events-auto">
                <div className="p-3 bg-black/30 backdrop-blur-sm rounded-xl border border-white/5">
                  <p className="text-[10px] text-white/50 uppercase mb-2 font-bold">Guía de Supervivencia</p>
                  <div className="space-y-1 text-xs text-white/80">
                    <div className="flex justify-between"><span>Moverse:</span><span className="text-emerald-400">WASD (Invertido)</span></div>
                    <div className="flex justify-between"><span>Acción / Construir:</span><span className="text-emerald-400">Click Izq</span></div>
                    <div className="flex justify-between"><span>Cancelar / Romper:</span><span className="text-emerald-400">Click Der</span></div>
                    <div className="flex justify-between"><span>Girar Estructura:</span><span className="text-emerald-400">Misma Tecla / Botón</span></div>
                    <div className="flex justify-between"><span>Pausar:</span><span className="text-emerald-400">P / Esc</span></div>
                  </div>
                </div>
              </div>

              {/* Barra de Herramientas (Selector) */}
              <div className="flex gap-4 p-4 bg-black/60 backdrop-blur-xl border border-white/10 rounded-3xl items-center pointer-events-auto">
                {/* Hacha */}
                <div className={`w-16 h-16 rounded-2xl flex flex-col items-center justify-center relative transition-colors ${uiState.tool === 'axe' ? 'bg-emerald-500/20 border-2 border-emerald-500' : 'bg-white/5 border border-white/10 grayscale opacity-60'}`}>
                  <span className={`absolute -top-2 -left-2 text-[10px] font-bold px-1.5 rounded ${uiState.tool === 'axe' ? 'bg-emerald-500 text-black' : 'bg-white/20 text-white/60'}`}>1</span>
                  <div className="text-2xl">🪓</div>
                  <span className={`text-[9px] uppercase font-bold mt-1 ${uiState.tool === 'axe' ? 'text-white' : 'text-white/60 font-mono'}`}>Hacha</span>
                </div>
                {/* Pico */}
                <div className={`w-16 h-16 rounded-2xl flex flex-col items-center justify-center relative transition-colors ${uiState.tool === 'pickaxe' ? 'bg-emerald-500/20 border-2 border-emerald-500' : 'bg-white/5 border border-white/10 grayscale opacity-60'}`}>
                  <span className={`absolute -top-2 -left-2 text-[10px] font-bold px-1.5 rounded ${uiState.tool === 'pickaxe' ? 'bg-emerald-500 text-black' : 'bg-white/20 text-white/60'}`}>2</span>
                  <div className="text-2xl">⛏️</div>
                  <span className={`text-[9px] uppercase font-bold mt-1 ${uiState.tool === 'pickaxe' ? 'text-white' : 'text-white/60 font-mono'}`}>Pico</span>
                </div>
              </div>

              {/* Inventario de Recursos */}
              <div className="w-64 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-black/40 backdrop-blur-md border border-white/10 p-3 rounded-2xl flex items-center justify-between">
                    <div className="text-lg">🪵</div>
                    <div className="text-right leading-none">
                      <span className="block text-xs uppercase text-white/40 font-bold mb-1">Madera</span>
                      <span className="text-xl font-mono text-white">{uiState.wood.toString().padStart(2, '0')}</span>
                    </div>
                  </div>
                  <div className="bg-black/40 backdrop-blur-md border border-white/10 p-3 rounded-2xl flex items-center justify-between">
                    <div className="text-lg">🪨</div>
                    <div className="text-right leading-none">
                      <span className="block text-xs uppercase text-white/40 font-bold mb-1">Piedra</span>
                      <span className="text-xl font-mono text-white">{uiState.stone.toString().padStart(2, '0')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay Sutil (Velo inicial) */}
      <div className="absolute inset-0 pointer-events-none border-[16px] border-black/20 z-20">
        <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.3)]"></div>
      </div>

      {/* MENUS */}
      <AnimatePresence>
        {uiState.status === 'menu' && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-[#0a120a]/90 backdrop-blur-md flex items-center justify-center z-50 pointer-events-auto"
          >
            <div className="text-center p-12 bg-black/60 border border-emerald-900/50 rounded-2xl shadow-2xl backdrop-blur-xl">
              <h1 className="text-5xl font-black text-white mb-4 tracking-tighter uppercase leading-none">SOLO <br/><span className="text-emerald-500">33</span></h1>
              <p className="text-emerald-100/60 mb-8 max-w-sm mx-auto font-medium">Sobrevive en un entorno hostil. Tala árboles, pica piedras y crea un refugio antes de que las criaturas te alcancen. Solo resiste hasta que ellos lleguen.</p>
              <div className="flex flex-col gap-4">
                 {hasSave && (
                    <button onClick={() => initGame(true)} className="px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-lg transition-transform hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(16,185,129,0.4)] tracking-wider uppercase">
                      CONTINUAR PARTIDA GUARDADA
                    </button>
                 )}
                 <button onClick={() => initGame(false)} className={`px-8 py-4 ${hasSave ? 'bg-zinc-800 hover:bg-zinc-700 text-white/80' : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.4)]'} font-bold rounded-lg text-lg transition-transform hover:scale-105 active:scale-95 tracking-wider uppercase`}>
                   {hasSave ? 'NUEVA EXPEDICIÓN' : 'INICIAR EXPEDICIÓN'}
                 </button>
              </div>
            </div>
          </motion.div>
        )}

        {uiState.status === 'paused' && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 pointer-events-auto"
          >
            <div className="text-center p-12 bg-[#0a120a]/80 border border-emerald-900/50 rounded-2xl shadow-2xl backdrop-blur-xl w-96">
              <h1 className="text-4xl font-black text-white mb-8 tracking-tighter uppercase leading-none">PAUSADO</h1>
              
              <div className="flex flex-col gap-4">
                <button onClick={() => { gs.status = 'playing'; setTriggerUI(Date.now()); }} className="w-full px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-lg transition-transform hover:scale-105 active:scale-95 shadow-[0_0_15px_rgba(16,185,129,0.4)] tracking-wider uppercase">
                  SEGUIR JUGANDO
                </button>
                
                <div className="px-6 py-4 bg-white/5 border border-white/10 rounded-lg">
                   <p className="text-xs uppercase tracking-widest text-emerald-400 font-bold mb-3">Volumen Fondo</p>
                   <input 
                      type="range" min="0" max="1" step="0.05" 
                      value={uiState.volume}
                      onChange={(e) => {
                         audio.setVolume(parseFloat(e.target.value));
                         setTriggerUI(Date.now());
                      }}
                      className="w-full accent-emerald-500"
                   />
                </div>

                <button onClick={() => { gs.status = 'credits'; setTriggerUI(Date.now()); }} className="w-full px-6 py-3 bg-zinc-800 hover:bg-emerald-600/30 border border-emerald-500/30 text-white font-bold rounded-lg text-sm transition-colors tracking-wider uppercase">
                  VER CRÉDITOS
                </button>
                
                <button onClick={saveGameAndLeave} className="w-full px-6 py-3 bg-zinc-800 hover:bg-red-600/30 border border-red-500/30 text-white font-bold rounded-lg text-sm transition-colors tracking-wider uppercase">
                  GUARDAR Y DEJAR PARTIDA
                </button>
              </div>
            </div>
          </motion.div>
        )}
        
        {uiState.status === 'credits' && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/95 backdrop-blur-md flex items-center justify-center z-50 pointer-events-auto"
          >
            <div className="text-center max-w-lg p-12">
              <h1 className="text-4xl font-black text-emerald-500 mb-8 tracking-tighter uppercase leading-none">CRÉDITOS</h1>
              <div className="space-y-6 text-white/80 font-medium">
                  <p>Desarrollo y Diseño:<br/><span className="text-white font-bold text-lg">AI Studio Code Agent</span></p>
                  <p>Inspirado en los juegos de recolección y supervivencia retro.</p>
                  <p>Sonidos:<br/>SonidosMP3Gratis.com y Síntesis Web Audio API</p>
              </div>
              <button onClick={() => { gs.status = 'paused'; setTriggerUI(Date.now()); }} className="mt-12 px-8 py-3 border border-emerald-500/50 hover:bg-emerald-600/20 text-white font-bold rounded-lg text-sm transition-all tracking-wider uppercase">
                VOLVER
              </button>
            </div>
          </motion.div>
        )}

        {uiState.status === 'gameover' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-[#120a0a]/95 backdrop-blur-md flex items-center justify-center z-50 pointer-events-auto"
          >
            <div className="text-center p-12 bg-black/80 border border-red-900/50 rounded-2xl shadow-2xl backdrop-blur-xl">
              <h1 className="text-6xl font-black text-red-500 mb-4 tracking-tighter uppercase leading-none">JUEGO TERMINADO</h1>
              <p className="text-red-200/80 mb-8 font-medium italic">Has sido derrotado por el bosque.</p>
              <div className="flex justify-center gap-6 mb-8 text-white/80">
                <div className="bg-black/50 border border-white/5 p-4 rounded-xl min-w-[80px]">
                  <span className="block text-3xl font-mono text-emerald-400">{uiState.wood.toString().padStart(2, '0')}</span> 
                  <span className="text-[10px] uppercase tracking-widest text-white/40 mt-1 block">Madera</span>
                </div>
                <div className="bg-black/50 border border-white/5 p-4 rounded-xl min-w-[80px]">
                  <span className="block text-3xl font-mono text-gray-300">{uiState.stone.toString().padStart(2, '0')}</span> 
                  <span className="text-[10px] uppercase tracking-widest text-white/40 mt-1 block">Piedra</span>
                </div>
                <div className="bg-black/50 border border-white/5 p-4 rounded-xl min-w-[80px]">
                  <span className="block text-3xl font-mono text-blue-400">{uiState.house + uiState.campfires + uiState.doors}</span> 
                  <span className="text-[10px] uppercase tracking-widest text-white/40 mt-1 block">Construcciones</span>
                </div>
              </div>
              <button onClick={initGame} className="px-8 py-4 bg-red-600 hover:bg-red-500 text-white font-bold rounded-lg text-lg transition-transform hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(239,68,68,0.4)] tracking-wider uppercase">
                REINICIAR MISIÓN
              </button>
            </div>
          </motion.div>
        )}

        {uiState.status === 'win' && uiState.ufoTimer > 6 && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="absolute inset-0 bg-[#0a120a]/95 backdrop-blur-md flex items-center justify-center z-50 pointer-events-auto"
          >
            <div className="text-center p-12 bg-black/80 border border-[#10B981]/50 rounded-2xl shadow-2xl backdrop-blur-xl">
              <h1 className="text-6xl font-black text-[#10B981] mb-6 tracking-tighter mix-blend-screen drop-shadow-2xl uppercase leading-none">
                MISTERIO REVELADO
              </h1>
              <p className="text-xl text-emerald-200/80 max-w-lg mx-auto text-center mb-12 font-medium">
                Sobreviviste los 33 días. Sin embargo, te han llevado, y los seres dentro de la nave... son iguales a ti.
              </p>
              <button onClick={initGame} className="px-8 py-4 bg-[#34D399] hover:bg-[#10B981] text-black font-black rounded-lg transition-transform hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(16,185,129,0.5)] tracking-widest uppercase text-lg">
                INICIAR OTRA VIDA
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

