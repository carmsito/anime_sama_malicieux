import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed, wait
import os
import re
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import requests.exceptions as req_exceptions
import tkinter as tk
import glob
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import NoSuchElementException, TimeoutException
from webdriver_manager.chrome import ChromeDriverManager
from urllib.parse import urljoin
try:
	from PIL import Image
	PIL_AVAILABLE = True
except Exception:
	PIL_AVAILABLE = False

# --- Initialisation du navigateur ---
url = "https://anime-sama.fr/"
service = Service(ChromeDriverManager().install())
driver = webdriver.Chrome(service=service)
driver.get(url)
time.sleep(2)

try:
	wait = WebDriverWait(driver, 5)
	accept_btn = wait.until(EC.element_to_be_clickable((By.ID, "accept-btn")))
	accept_btn.click()
	WebDriverWait(driver, 5).until(EC.invisibility_of_element_located((By.ID, "qc-cmp2-ui")))
except (NoSuchElementException, TimeoutException):
	pass


# --- Interface terminal ---
def gui_terminal():
	root = tk.Tk()
	root.title("Terminal Anime-sama")
	root.geometry("900x600")
	root.configure(bg="black")
	# Laisser la bordure et la barre de titre pour permettre de déplacer/redimensionner/fermer
	# Appliquer une opacité sur la fenêtre (effet semi-transparent)
	try:
		root.attributes('-alpha', 0.80)  # 0.0 = transparent, 1.0 = opaque
	except Exception:
		pass

	font = ("Consolas", 12)


	# Header area: shows last action and available options
	header_frame = tk.Frame(root, bg='black')
	header_frame.pack(fill='x', padx=8, pady=(8,0))
	header_label = tk.Label(header_frame, text=' ', fg='#FFFFFF', bg='black', font=("Consolas", 12, 'bold'))
	header_label.pack(anchor='w')
	options_label = tk.Label(header_frame, text=' ', fg='#AAAAAA', bg='black', font=("Consolas", 10))
	options_label.pack(anchor='w')

	output = tk.Text(root, bg="black", fg="#00FF00", font=font,
				 insertbackground="#00FF00", state="disabled", borderwidth=0, highlightthickness=0, relief='flat')
	output.pack(padx=8, pady=(4, 0), fill="both", expand=True)

	# Frame pour la ligne de saisie façon terminal
	input_frame = tk.Frame(root, bg="black", borderwidth=0, highlightthickness=0, relief='flat')
	input_frame.pack(fill="x", padx=0, pady=(0,0), side='bottom')
	prompt_label = tk.Label(input_frame, text='> ', fg='#00FF00', bg='black', font=font, borderwidth=0, highlightthickness=0)
	prompt_label.pack(side='left', padx=(8,0), pady=(0,8))
	entry_var = tk.StringVar()
	entry = tk.Entry(input_frame, textvariable=entry_var, bg='black', fg='#00FF00',
					insertbackground='#00FF00', font=font, borderwidth=0, highlightthickness=0, relief='flat')
	entry.pack(side='left', fill='x', expand=True, padx=(0,8), pady=(0,8))
	entry.focus_set()

	# Variable utilisée pour valider la sélection (appui sur Entrée en mode sélection)
	submit_var = tk.StringVar()
	# Mode: False = saisie de recherche, True = saisie de sélection
	selection_mode = {'value': False}

	# Conserver le contexte courant (manga / category) pour les extractions
	current_manga = {'value': None}
	current_category = {'value': None}

	def print_out(msg):
		output.config(state="normal")
		output.insert(tk.END, msg + "\n")
		output.see(tk.END)
		output.config(state="disabled")

	def clear_and_prompt():
		output.config(state="normal")
		output.delete('1.0', tk.END)
		output.config(state="disabled")
		# update header to show current state and options
		update_header('Prêt — recherche', "Options: back=b, reset=reset")
		print_out("Quel scan veux-tu regarder ?")


	def update_header(action_text, options_text=''):
		# keep header visible and concise
		header_label.config(text=action_text)
		options_label.config(text=options_text)

	# Build a requests session with adapter retries and provide an explicit fetch helper
	def make_session_with_retries(total=3, backoff_factor=0.5):
		s = requests.Session()
		retries = Retry(total=total,
				backoff_factor=backoff_factor,
				status_forcelist=[429, 500, 502, 503, 504],
				allowed_methods=frozenset(['GET', 'POST']))
		# increase pool sizes so we can reuse many connections in parallel
		adapter = HTTPAdapter(max_retries=retries, pool_connections=50, pool_maxsize=50)
		s.mount('https://', adapter)
		s.mount('http://', adapter)
		return s

	# session used by downloader
	session = make_session_with_retries(total=3, backoff_factor=0.5)

	def fetch_with_retries(url, tries=4, timeout=12):
		"""Try to GET url using the shared session with exponential backoff for network errors.
		Returns Response or None on permanent failure.
		"""
		wait = 1
		for attempt in range(tries):
			try:
				resp = session.get(url, timeout=timeout)
				return resp
			except req_exceptions.RequestException as e:
				# print a short message in the GUI output for visibility
				print_out(f"[Network] tentative {attempt+1}/{tries} échouée: {e}")
				if attempt == tries - 1:
					return None
				time.sleep(wait)
				wait *= 2


	# Helper functions for extraction and downloads (moved to gui_terminal scope)
	def wait_for_user(prompt, allow_empty=False):
		print_out('')
		print_out(prompt)
		selection_mode['value'] = True
		submit_var.set("")
		root.wait_variable(submit_var)
		val = submit_var.get().strip()
		selection_mode['value'] = False
		if not val and not allow_empty:
			return None
		return val

	def derive_template_from_src(src):
		m = re.search(r"(?P<prefix>.*/)(?P<chap>\d+)/(?P<page>\d+)\.jpg", src)
		if not m:
			return None
		prefix = m.group('prefix')
		return prefix + "{chapter}/{page}.jpg"

	def sanitize_name(name):
		from urllib.parse import unquote
		n = unquote(name)
		n = n.replace('/', '_').replace('\\', '_')
		return n

	def download_chapter_images(base_url, template, manga_name, category_name, chapter, progress_prefix=''):
		# determine effective manga/category from provided args or current context
		effective_manga = manga_name or current_manga.get('value') or 'unknown'
		effective_category = category_name or current_category.get('value') or 'scan'
		out_dir = os.path.join('extraction', sanitize_name(effective_manga), sanitize_name(effective_category), f"Chapitre {chapter}")
		os.makedirs(out_dir, exist_ok=True)
		# Determine start page: if no images -> start at 1; if some images exist -> resume at first missing page
		existing = sorted(glob.glob(os.path.join(out_dir, '*.jpg')))
		page = 1
		if existing:
			# extract numeric filenames like 1.jpg, 2.jpg
			nums = []
			for p in existing:
				bn = os.path.basename(p)
				m = re.match(r"^(\d+)\.jpg$", bn)
				if m:
					nums.append(int(m.group(1)))
			if nums:
				nums = sorted(set(nums))
				# find first missing page in the sequence starting at 1
				for n in nums:
					if n == page:
						page += 1
					elif n > page:
						break
				if page == 1:
					# all existing files did not match numeric pattern -> treat as present but try to fill from 1
					print_out(f"{progress_prefix} Chapitre {chapter} contient des fichiers non-numérotés ({len(existing)}) -> reprise à la page 1")
				else:
					# if the first missing page is beyond the highest existing, decide whether chapter is complete
					# we'll attempt to fetch starting at 'page' (which will be highest+1 if contiguous)
					print_out(f"{progress_prefix} Chapitre {chapter} partiellement présent ({len(nums)} images) -> reprise à la page {page}")
			else:
				# some files present but none match numeric pattern -> start at 1
				page = 1
		downloaded = 0
		# If chapter folder was empty, probe first few pages to detect if the template is valid
		if not existing:
			probe_ok = False
			for probe_page in range(1, 6):
				probe_path = template.format(chapter=chapter, page=probe_page)
				probe_url = urljoin(base_url, probe_path)
				try:
					resp = fetch_with_retries(probe_url, tries=3, timeout=8)
					if resp and resp.status_code == 200 and not resp.headers.get('Content-Type', '').startswith('text') and b'Page introuvable' not in resp.content:
						probe_ok = True
						print_out(f"{progress_prefix} probe page {probe_page}: OK -> remplissage du chapitre")
						break
				except Exception:
					continue
			if not probe_ok:
				print_out(f"{progress_prefix} Aucune des {5} premières pages trouvée pour ce chapitre -> considérer vide.")
				return 0
		while True:
			img_path = template.format(chapter=chapter, page=page)
			url_img = urljoin(base_url, img_path)
			try:
				resp = fetch_with_retries(url_img, tries=4, timeout=12)
				if resp is None:
					print_out(f"{progress_prefix} page {page}: réseau indisponible -> stop chapter")
					break
				if resp.status_code != 200:
					print_out(f"{progress_prefix} page {page}: status {resp.status_code} -> stop chapter")
					break
				if resp.headers.get('Content-Type', '').startswith('text') or b'Page introuvable' in resp.content:
					print_out(f"{progress_prefix} page {page}: got error page -> stop chapter")
					break
				fname = os.path.join(out_dir, f"{page}.jpg")
				if os.path.exists(fname):
					print_out(f"{progress_prefix} page {page}: exists, skipping")
				else:
					# write raw bytes first
					with open(fname, 'wb') as f:
						f.write(resp.content)
					# try to strip metadata if Pillow is available
					if PIL_AVAILABLE:
						try:
							with Image.open(fname) as im:
								data = list(im.getdata())
								clean = Image.new(im.mode, im.size)
								clean.putdata(data)
								clean.save(fname, format='JPEG', quality=95, optimize=True)
							print_out(f"{progress_prefix} page {page}: downloaded (metadata stripped)")
						except Exception as e:
							print_out(f"{progress_prefix} page {page}: downloaded but failed to strip metadata: {e}")
					else:
						print_out(f"{progress_prefix} page {page}: downloaded (Pillow absent, raw bytes written)")
				downloaded += 1
				page += 1
			except Exception as e:
				print_out(f"{progress_prefix} page {page}: error {e} -> stop chapter")
				break
		return downloaded

	def download_range(base_url, template, manga_name, category_name, start_chap, end_chap):
		# normalize names
		effective_manga = manga_name or current_manga.get('value') or 'unknown'
		effective_category = category_name or current_category.get('value') or 'scan'
		# If end_chap is None -> auto mode: continue chapters until a chapter yields 0 pages
		if end_chap is None:
			print_out(f"Démarrage du téléchargement en mode AUTO (multithread): {effective_manga} {effective_category} à partir du chapitre {start_chap}")
			# multithreaded coordinator
			total = 0
			max_empty = 3
			max_workers = 6
			results = {}  # chap -> pages downloaded
			futures = {}
			next_chap = start_chap
			last_consumed = start_chap - 1
			consecutive_empty = 0
			stop = False
			with ThreadPoolExecutor(max_workers=max_workers) as ex:
				# submit initial batch
				for _ in range(max_workers):
					f = ex.submit(download_chapter_images, base_url, template, effective_manga, effective_category, next_chap, f"[Chap {next_chap}]")
					futures[f] = next_chap
					next_chap += 1
				# process completions and keep feeding the pool
				while futures and not stop:
					done, _ = wait(futures.keys(), return_when='FIRST_COMPLETED')
					for fut in done:
						chap = futures.pop(fut)
						try:
							d = fut.result()
						except Exception as e:
							print_out(f"[Chap {chap}] erreur: {e}")
							d = 0
						results[chap] = d
						# advance last_consumed as far as possible
						while True:
							next_expected = last_consumed + 1
							if next_expected in results:
								val = results[next_expected]
								last_consumed = next_expected
								if val == 0:
									consecutive_empty += 1
								else:
									consecutive_empty = 0
								# accumulate total
								total += val
							else:
								break
						# stop condition: reached detected_max_chap or consecutive empties
						if end_chap is not None and last_consumed >= end_chap:
							stop = True
							break
						if consecutive_empty >= max_empty:
							print_out(f"Arrêt auto: {consecutive_empty} chapitres consécutifs vides détectés (arrêt).")
							stop = True
							break
					# submit next chapter if we haven't hit a detected max
					if not stop:
						# if we have a detected max, don't go past it
						if end_chap is None or next_chap <= end_chap:
							f2 = ex.submit(download_chapter_images, base_url, template, effective_manga, effective_category, next_chap, f"[Chap {next_chap}]")
							futures[f2] = next_chap
							next_chap += 1
						else:
							# nothing more to submit
							if not futures:
								stop = True
				# end while futures
			# after executor
			print_out(f"Téléchargement terminé. pages totales: {total}")
			return

		# Normal bounded mode
		print_out(f"Démarrage du téléchargement (parallèle): {effective_manga} {effective_category} chapitres {start_chap} à {end_chap}")
		# parallelize chapter downloads with a small thread pool to speed up bounded ranges
		total = 0
		max_workers = min(4, max(1, end_chap - start_chap + 1))
		with ThreadPoolExecutor(max_workers=max_workers) as ex:
			futures = {ex.submit(download_chapter_images, base_url, template, effective_manga, effective_category, chap, f"[Chap {chap}]"): chap for chap in range(start_chap, end_chap + 1)}
			for fut in as_completed(futures):
				chap = futures[fut]
				try:
					d = fut.result()
				except Exception as e:
					print_out(f"[Chap {chap}] erreur pendant le téléchargement: {e}")
					d = 0
				total += d
				# afficher le résultat par chapitre
				print_out(f"[Chap {chap}] -> {d} pages")
		print_out(f"Téléchargement terminé. pages totales: {total}")

	def try_offer_extraction(manga_name=None, category_name=None):
		def reset_buffer():
			current_manga['value'] = None
			current_category['value'] = None

		# resolve effective names from args or buffer
		effective_manga = manga_name or current_manga.get('value')
		effective_category = category_name or current_category.get('value')
		# detected max chapter from page selector (if any)
		detected_max_chap = None
		try:
			imgs = driver.find_elements(By.CSS_SELECTOR, '#scansPlacement img')
			if not imgs:
				print_out('Aucune galerie d\'images détectée sur cette page.')
				# nothing to extract; keep buffer as-is
				return False
			first_src = imgs[0].get_attribute('src')
			if not first_src:
				print_out('Impossible de récupérer le src du premier <img>.')
				reset_buffer()
				return False
			tmpl = derive_template_from_src(first_src)
			if not tmpl:
				print_out("Impossible de déterminer le template d'images.")
				reset_buffer()
				return False
			print_out("Template d'images détecté: " + tmpl)
			# If the page contains a chapter selector, show the available range (first -> last)
			try:
				select_el = driver.find_element(By.ID, 'selectChapitres')
				opts = select_el.find_elements(By.TAG_NAME, 'option')
				if opts:
					first_txt = (opts[0].text or '').strip()
					last_txt = (opts[-1].text or '').strip()
					# try to extract numbers
					m1 = re.search(r"(\d+)", first_txt)
					m2 = re.search(r"(\d+)", last_txt)
					if m1 and m2:
						print_out(f"Chapitres disponibles : {m1.group(1)} - {m2.group(1)}")
						try:
							detected_max_chap = int(m2.group(1))
						except Exception:
							detected_max_chap = None
					else:
						print_out(f"Chapitres disponibles : {first_txt} ... {last_txt}")
			except Exception:
				# no selector present — ignore
				pass
			ans = wait_for_user("Lancer extraction de ces scans ? (y/n) [défaut: y pour auto]")
			# Empty answer defaults to 'y' (useful for auto/background runs)
			if ans is None:
				print_out('Extraction annulée.')
				reset_buffer()
				return True
			if ans.strip() == "":
				ans = 'y'
			if ans.lower() not in ('y', 'yes'):
				print_out('Extraction annulée.')
				reset_buffer()
				return True
			start = wait_for_user('Chapitre début (nombre):')
			if not start or not start.isdigit():
				print_out('Chapitre début invalide, annulation.')
				reset_buffer()
				return True
			end = wait_for_user('Chapitre fin (nombre) ou laisser vide / entrer "a" pour AUTO :')
			start_chap = int(start)
			# support auto mode
			if end is None:
				print_out('Chapitre fin invalide, annulation.')
				reset_buffer()
				return True
			end_str = end.strip()
			if end_str == '' or end_str.lower() == 'a':
				# AUTO requested; if we detected a max chapter from the page, use it to avoid stopping
				if detected_max_chap is not None:
					end_chap = detected_max_chap
				else:
					end_chap = None
			else:
				if not end_str.isdigit():
					print_out('Chapitre fin invalide, annulation.')
					reset_buffer()
					return True
				end_chap = int(end_str)
			# ensure we pass the resolved buffer values
			if not effective_manga:
				effective_manga = 'unknown'
			if not effective_category:
				effective_category = 'scan'
			threading.Thread(target=download_range, args=(url, tmpl, effective_manga, effective_category, start_chap, end_chap), daemon=True).start()
			return True
		except Exception:
			print_out('Erreur lors de la préparation de l\'extraction.')
			return False
 

	def search_scan(scan):
		wait = WebDriverWait(driver, 10)
		import traceback
		try:
			# Localiser l'input
			input_box = wait.until(EC.presence_of_element_located((By.ID, "search_text")))
			print("[Debug] Input trouvé, tentative d'interaction...")
			# Scroll et click pour s'assurer qu'il est visible
			driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", input_box)
			try:
				input_box.click()
			except Exception:
				print("[Debug] click() sur l'input a échoué (non critique)")

			# Essayer send_keys
			try:
				input_box.clear()
				input_box.send_keys(scan)
				print(f"[Info] Tentative send_keys('{scan}')")
			except Exception as e:
				print(f"[Debug] send_keys a levé: {e} - on bascule sur injection JS")
				# fallback : injecter la valeur via JS et dispatcher input
				driver.execute_script(
					"arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('input', {bubbles:true}));",
					input_box, scan)
				print(f"[Info] Valeur injectée via JS: '{scan}'")

			# Vérifier que la valeur a bien été placée
			val = input_box.get_attribute('value')
			print(f"[Debug] valeur dans le champ = '{val}'")

			# Cas où le site attend aussi un Enter
			try:
				input_box.send_keys('\n')
			except Exception:
				pass

			# Attendre que les résultats s'affichent (ou timeout)
			try:
				WebDriverWait(driver, 5).until(lambda d: d.find_element(By.ID, 'result').find_elements(By.TAG_NAME, 'a'))
			except Exception:
				print('[Debug] Pas (encore) de résultats visibles après saisie (délai atteint)')

			# Récupérer la div result et les liens
			result_div = driver.find_element(By.ID, "result")
			links = result_div.find_elements(By.TAG_NAME, "a")
			if not links:
				print_out("Aucun résultat trouvé.")
				# Afficher des infos de debug pour aider
				try:
					print(f"[Debug] result innerHTML length = {len(result_div.get_attribute('innerHTML') or '')}")
				except Exception:
					pass
				return
			print_out("\nRésultats trouvés :")
			items = []
			for i, link in enumerate(links, 1):
				# Essayer d'abord via JS pour récupérer innerText du h3 (plus fiable)
				try:
					titre = driver.execute_script(
						"const h = arguments[0].querySelector('h3'); return h ? h.innerText.trim() : null;",
						link)
				except Exception:
					titre = None
				if not titre:
					try:
						titre = link.find_element(By.TAG_NAME, 'h3').text.strip()
					except Exception:
						titre = (link.text or "").strip()
				if not titre:
					titre = "(sans titre)"
				print_out(f"{i}. {titre}")
				# store tuple (element, title)
				items.append((link, titre))

			# Demander à l'utilisateur quel numéro ouvrir
			print_out("")
			print_out("Quel numéro veux-tu ouvrir ? (ou rien pour annuler)")
			# Passer en mode sélection et attendre validation par Entrée
			selection_mode['value'] = True
			submit_var.set("")
			root.wait_variable(submit_var)
			choix = submit_var.get().strip()
			# sortir du mode sélection
			selection_mode['value'] = False
			# afficher la saisie dans le GUI
			if not choix:
				print_out("Recherche annulée.")
				clear_and_prompt()
				return
			print_out(f"> {choix}")
			if not choix.isdigit() or int(choix) < 1 or int(choix) > len(items):
				print_out("Choix invalide.")
				clear_and_prompt()
				return
			index = int(choix) - 1
			link_elem, manga_title = items[index]
			current_manga['value'] = manga_title
			href = link_elem.get_attribute('href')
			print_out(f"Ouverture de : {href}")
			update_header(f"Sélection: {manga_title}", "Options: back=b, reset=reset")
			driver.get(href)
			# Après ouverture, détecter les catégories (h2 suivi d'une div de contenu)
			try:
				WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.TAG_NAME, 'body')))
			except Exception:
				pass
			sections = []
			# Collecter les sections (h2 + immediate following div)
			try:
				h2s = driver.find_elements(By.XPATH, "//h2[following-sibling::div]")
				for h in h2s:
					try:
						title = h.text.strip()
						div = h.find_element(By.XPATH, "following-sibling::div[1]")
						links = div.find_elements(By.TAG_NAME, 'a')
						entries = []
						for a in links:
							try:
								href2 = a.get_attribute('href')
								try:
									label = driver.execute_script("const d=arguments[0].querySelector('div'); return d? d.innerText.trim(): arguments[0].innerText.trim();", a)
								except Exception:
									label = (a.text or '').strip()
								if href2:
									entries.append((a, href2, label))
							except Exception:
								continue
						if entries:
							sections.append((title, entries))
					except Exception:
						continue
			except Exception:
				sections = []


            
			# Si aucune section, fallback: chercher des liens 'scan' directement
			if not sections:
				try:
					WebDriverWait(driver, 3).until(lambda d: len(d.find_elements(By.CSS_SELECTOR, "a[href*='scan']")) > 0)
				except Exception:
					pass
				version_links = driver.find_elements(By.CSS_SELECTOR, "a[href*='scan']")
				clean_links = []
				seen = set()
				for a in version_links:
					try:
						h = a.get_attribute('href')
						t = (a.text or '').strip()
						if not h:
							continue
						# normalize
						h_full = urljoin(driver.current_url, h)
						if h_full in seen:
							continue
						seen.add(h_full)
						clean_links.append((a, h_full, t))
					except Exception:
						continue
				if not clean_links:
					# Pas de versions trouvées — la page a été ouverte correctement
					# Ne pas afficher de message intrusif ; revenir silencieusement
					return
				print_out('')
				print_out('Versions disponibles :')
				for i, (_a, h, t) in enumerate(clean_links, 1):
					label = t if t else h.split('/')[-1]
					print_out(f"{i}. {label}")
				# selection
				print_out('')
				print_out('Quel numéro de version veux-tu ouvrir ? (ou rien pour annuler)')
				selection_mode['value'] = True
				submit_var.set("")
				root.wait_variable(submit_var)
				version_choice = submit_var.get().strip()
				selection_mode['value'] = False
				if not version_choice:
					print_out('Annulation.')
					clear_and_prompt()
					return
				print_out(f"> {version_choice}")
				if not version_choice.isdigit() or int(version_choice) < 1 or int(version_choice) > len(clean_links):
					print_out('Choix invalide.')
					clear_and_prompt()
					return
				vindex = int(version_choice) - 1
				vhref = clean_links[vindex][1]
				print_out(f"Ouverture de la version : {vhref}")
				driver.get(vhref)
				return
			# Si on a des sections, permettre navigation avec option de retour
			BACK_COMMANDS = ('b', 'B', 'back', 'ret', 'r')
			while True:
				print_out('')
				print_out('Catégories disponibles :')
				for i, (title, entries) in enumerate(sections, 1):
					print_out(f"{i}. {title} ({len(entries)})")
				# Demander la catégorie
				print_out('')
				print_out("Quel numéro de catégorie veux-tu ouvrir ? (ou rien pour annuler)")
				selection_mode['value'] = True
				submit_var.set("")
				root.wait_variable(submit_var)
				cat_choice = submit_var.get().strip()
				selection_mode['value'] = False
				if not cat_choice:
					clear_and_prompt()
					return
				print_out(f"> {cat_choice}")
				if not cat_choice.isdigit() or int(cat_choice) < 1 or int(cat_choice) > len(sections):
					print_out('Choix invalide.')
					continue
				cat_index = int(cat_choice) - 1
				chosen_entries = sections[cat_index][1]
				# store section title as current category base (will be refined per-entry)
				current_category['value'] = sections[cat_index][0]
				update_header(f"Catégorie: {sections[cat_index][0]}", "Options: back=b, reset=reset")
				# Boucle sur les items de la catégorie
				while True:
					print_out('')
					print_out(f"Contenu de {sections[cat_index][0]} : (tape 'b' pour revenir aux catégories)")
					for i, (_a, h, label) in enumerate(chosen_entries, 1):
						print_out(f"{i}. {label}")
					# Demander quel item ouvrir
					print_out('')
					print_out("Quel numéro veux-tu ouvrir ? (ou rien pour annuler, 'b' pour revenir)")
					selection_mode['value'] = True
					submit_var.set("")
					root.wait_variable(submit_var)
					item_choice = submit_var.get().strip()
					selection_mode['value'] = False
					if not item_choice:
						clear_and_prompt()
						return
					if item_choice in BACK_COMMANDS:
						# revenir à la liste des catégories
						break
					print_out(f"> {item_choice}")
					if not item_choice.isdigit() or int(item_choice) < 1 or int(item_choice) > len(chosen_entries):
						print_out('Choix invalide.')
						continue
					item_index = int(item_choice) - 1
					_a, item_href, item_label = chosen_entries[item_index]
					item_href = urljoin(driver.current_url, item_href)
					# set current category to the specific entry label (e.g., 'Scans (couleur)')
					current_category['value'] = item_label or current_category['value']
					update_header(f"Entrée: {current_category['value']}", "Options: back=b, extract=extract, auto=auto")
					print_out(f"Ouverture de : {item_href}")
					driver.get(item_href)
					# Après ouverture de l'item, lister les versions
					try:
						WebDriverWait(driver, 3).until(lambda d: len(d.find_elements(By.CSS_SELECTOR, "a[href*='scan']")) > 0)
					except Exception:
						pass
					version_links = driver.find_elements(By.CSS_SELECTOR, "a[href*='scan']")
					clean_links = []
					seen = set()
					for a in version_links:
						try:
							h = a.get_attribute('href')
							t = (a.text or '').strip()
							if not h:
								continue
							h_full = urljoin(driver.current_url, h)
							if h_full in seen:
								continue
							seen.add(h_full)
							clean_links.append((a, h_full, t))
						except Exception:
							continue
					if not clean_links:
						print_out('Aucune version trouvée pour ce catalogue.')
						# Si aucune version mais une galerie d'images est présente, proposer extraction
						try:
							imgs = driver.find_elements(By.CSS_SELECTOR, '#scansPlacement img')
							if imgs:
								# Show first src and resolved URL so user can inspect formatting
								first_src = imgs[0].get_attribute('src')
								print_out('Premier src brut: ' + (first_src or 'None'))
								resolved_src = urljoin(driver.current_url, first_src or '')
								print_out('URL résolue : ' + resolved_src)
								print_out('Galerie d\'images détectée sur cette page. Veux-tu lancer l\'extraction ? (y/n ou b pour revenir)')
								selection_mode['value'] = True
								submit_var.set("")
								root.wait_variable(submit_var)
								action = submit_var.get().strip()
								selection_mode['value'] = False
								if not action:
									print_out('Reste sur la page. Tu peux retenter ou revenir plus tard (tape b).')
									continue
								if action in BACK_COMMANDS:
									try:
										driver.back()
									except Exception:
										pass
									break
								if action.lower() in ('y', 'yes'):
									# Lancer l'extraction en utilisant les helpers existants (exécution synchrone pour prompts)
									started = try_offer_extraction(None, None)
									# n'afficher le démarrage en arrière-plan que si le thread a bien été lancé
									if started:
										update_header('Extraction en cours', 'Options: b pour revenir')
										print_out('Extraction démarrée en arrière-plan.')
										clear_and_prompt()
										return
									else:
										print_out('Extraction non démarrée.')
										# rester sur la page pour permettre une nouvelle tentative
										continue
								# sinon continuer à rester sur la page
								print_out('Reste sur la page. Tu peux retenter ou revenir plus tard (tape b).')
						except Exception:
							# fallback to original prompt if anything goes wrong
							print_out('')
							print_out("Tape 'b' pour revenir aux catégories, ou Entrée pour rester sur la page.")
							selection_mode['value'] = True
							submit_var.set("")
							root.wait_variable(submit_var)
							action = submit_var.get().strip()
							selection_mode['value'] = False
							if action in BACK_COMMANDS:
								try:
									driver.back()
								except Exception:
									pass
								# revenir à la liste des catégories
								break
							# sinon rester sur la page (on retombe sur la boucle d'items)
							print_out('Reste sur la page. Tu peux retenter ou revenir plus tard (tape b).')
							continue
					print_out('')
					print_out("Versions disponibles : (tape 'b' pour revenir)")
					for i, (_a, h, t) in enumerate(clean_links, 1):
						label = t if t else h.split('/')[-1]
						print_out(f"{i}. {label}")
					# Demander choix de version
					print_out('')
					print_out("Quel numéro de version veux-tu ouvrir ? (ou rien pour annuler, 'b' pour revenir)")
					selection_mode['value'] = True
					submit_var.set("")
					root.wait_variable(submit_var)
					version_choice = submit_var.get().strip()
					selection_mode['value'] = False
					if not version_choice:
						print_out('Annulation.')
						clear_and_prompt()
						return
					if version_choice in BACK_COMMANDS:
						# revenir à la liste d'items (on revient en arrière)
						driver.back()
						# attendre que la page soit prête puis continuer la boucle d'items
						try:
							WebDriverWait(driver, 3).until(lambda d: True)
						except Exception:
							pass
						continue
					print_out(f"> {version_choice}")
					if not version_choice.isdigit() or int(version_choice) < 1 or int(version_choice) > len(clean_links):
						print_out('Choix invalide.')
						continue
					vindex = int(version_choice) - 1
					vhref = clean_links[vindex][1]
					print_out(f"Ouverture de la version : {vhref}")
					driver.get(vhref)
					# après ouverture finale, on peut proposer de revenir aux catégories ou quitter
					print_out('')
					print_out("Tape 'b' pour revenir aux catégories, ou Entrée pour quitter la navigation.")
					selection_mode['value'] = True
					submit_var.set("")
					root.wait_variable(submit_var)
					cont = submit_var.get().strip()
					selection_mode['value'] = False
					if cont in BACK_COMMANDS:
						driver.back()
						continue
					# sinon on quitte la navigation
					clear_and_prompt()
					return
		except Exception as e:
			print(f"[Erreur Selenium] {e}")
			for line in traceback.format_exc().splitlines():
				print(line)

	def on_enter(event):
		# Comportement différent selon le mode
		if selection_mode['value']:
			# Valider la sélection
			submit_var.set(entry_var.get())
			entry_var.set("")
			return
		# Mode recherche or command
		scan = entry_var.get().strip()
		if not scan:
			return
		# special command: extract current page
		if scan.lower() in ('extract', 'download'):
			print_out('Lancement de l\'extraction sur la page courante...')
			entry_var.set("")
			# run synchronously so GUI prompts work correctly
			started = try_offer_extraction()
			if started:
				update_header('Extraction en cours', 'Options: b pour revenir')
				print_out('Extraction démarrée en arrière-plan.')
			return
		# debug command: show first image src and resolved URL
		if scan.lower() in ('src', 'showsrc', 'show-src'):
			entry_var.set("")
			try:
				imgs = driver.find_elements(By.CSS_SELECTOR, '#scansPlacement img')
				if not imgs:
					print_out('Aucune image détectée sur la page (sélecteur #scansPlacement img).')
				else:
					first = imgs[0].get_attribute('src')
					print_out('Premier src brut: ' + (first or 'None'))
					resolved = urljoin(driver.current_url, first or '')
					print_out('URL résolue : ' + resolved)
			except Exception as e:
				print_out('Erreur lors de la récupération du src: ' + str(e))
			return

		# quick auto-extract: derive template from first img and run auto mode (no end)
		if scan.lower() in ('auto', 'start', 'auto-extract', 'start-src'):
			entry_var.set("")
			try:
				imgs = driver.find_elements(By.CSS_SELECTOR, '#scansPlacement img')
				if not imgs:
					print_out('Aucune image détectée sur la page (sélecteur #scansPlacement img).')
					return
				first_src = imgs[0].get_attribute('src')
				tmpl = derive_template_from_src(first_src)
				print_out('Premier src brut: ' + (first_src or 'None'))
				print_out('Template dérivé: ' + (tmpl or 'None'))
				if not tmpl:
					print_out('Impossible de déterminer le template d\'images à partir du premier src.')
					return
				start = wait_for_user('Chapitre début (nombre) [défaut 1]:', allow_empty=True)
				if not start or not start.strip().isdigit():
					start_chap = 1
				else:
					start_chap = int(start.strip())
				threading.Thread(target=download_range, args=(url, tmpl, None, None, start_chap, None), daemon=True).start()
				print_out(f"Extraction AUTO démarrée à partir du chapitre {start_chap} (mode incrémental)...")
			except Exception as e:
				print_out('Erreur lors du démarrage de l\'extraction AUTO: ' + str(e))
			return
		print_out(f"> {scan}")
		entry_var.set("")
		threading.Thread(target=search_scan, args=(scan,), daemon=True).start()

	entry.bind("<Return>", on_enter)

	print_out("Bienvenue sur le terminal Anime-sama !")
	print_out("Tape le nom d'un scan et appuie sur Entrée.")
	print_out("")
	print_out("Quel scan veux-tu regarder ?")
	root.mainloop()


gui_terminal()
