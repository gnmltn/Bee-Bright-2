/**
 * BeeBright AI Response Datasets
 * 2000+ Q&A combinations for comprehensive AI training
 * Supports: English, Filipino, Taglish
 * Covers: Student, Tutor, Admin, Visitor roles
 */

const AIResponseDatasets = {
  // ===============================
  // STUDENT QUERIES (400 items)
  // ===============================
  studentQueries: [
    // Login & Authentication (40 items)
    {
      id: 'S001',
      role: 'student',
      topic: 'login',
      queries: {
        en: 'How do I log in to my student dashboard?',
        fil: 'Paano ako mag-login sa student dashboard?',
        tgl: 'Paano ako mag-login sa student dashboard?'
      },
      expectedReply: {
        en: 'Visit /login, enter your email and password, and click Sign In. If you forgot your password, use the "Forgot Password" option.',
        fil: 'Bumili sa /login, i-enter ang email at password, at i-click ang Sign In. Kung nakalimutan mo ang password, gamitin ang "Forgot Password" option.',
        tgl: 'Bumili sa /login, i-enter ang email at password, at i-click ang Sign In. Kung nakalimutan mo ang password, gamitin ang "Forgot Password" option.'
      }
    },
    {
      id: 'S002',
      role: 'student',
      topic: 'login',
      queries: {
        en: 'Where is the login page?',
        fil: 'Nasaan ang login page?',
        tgl: 'Nasaan ang login page?'
      },
      expectedReply: {
        en: 'The login page is at /login for students and tutors.',
        fil: 'Ang login page ay nasa /login para sa students at tutors.',
        tgl: 'Ang login page ay nasa /login para sa students at tutors.'
      }
    },
    {
      id: 'S003',
      role: 'student',
      topic: 'login',
      queries: {
        en: 'I forgot my password. What do I do?',
        fil: 'Nakalimutan ko ang password ko. Ano ang gagawin ko?',
        tgl: 'Nakalimutan ko ang password ko. Ano ang gagawin ko?'
      },
      expectedReply: {
        en: 'Click "Forgot Password" on the login page, enter your email, and follow the instructions sent to your email.',
        fil: 'I-click ang "Forgot Password" sa login page, i-enter ang email, at sundin ang instructions sa email.',
        tgl: 'I-click ang "Forgot Password" sa login page, i-enter ang email, at sundin ang instructions sa email.'
      }
    },
    {
      id: 'S004',
      role: 'student',
      topic: 'login',
      queries: {
        en: 'How do I create my student account?',
        fil: 'Paano ako gumawa ng student account?',
        tgl: 'Paano ako gumawa ng student account?'
      },
      expectedReply: {
        en: 'First complete enrollment, then you will receive login credentials via email.',
        fil: 'Matapos ang enrollment, matatanggap mo ang login credentials via email.',
        tgl: 'Matapos ang enrollment, matatanggap mo ang login credentials via email.'
      }
    },
    {
      id: 'S005',
      role: 'student',
      topic: 'login',
      queries: {
        en: 'Why can\'t I log in?',
        fil: 'Bakit hindi ako makaka-login?',
        tgl: 'Bakit hindi ako makaka-login?'
      },
      expectedReply: {
        en: 'Check if email and password are correct. If enrollment is not yet verified by admin, you cannot log in yet. Contact admin if you need help.',
        fil: 'Tingnan kung tama ang email at password. Kung hindi pa na-verify ng admin ang enrollment, hindi ka pa makaka-login. Kontakin ang admin kung kailangan mo ng tulong.',
        tgl: 'Tingnan kung tama ang email at password. Kung hindi pa na-verify ng admin ang enrollment, hindi ka pa makaka-login. Kontakin ang admin kung kailangan mo ng tulong.'
      }
    },
    // Enrollment (40 items)
    {
      id: 'S006',
      role: 'student',
      topic: 'enrollment',
      queries: {
        en: 'How do I enroll in a program?',
        fil: 'Paano ako mag-enroll sa program?',
        tgl: 'Paano ako mag-enroll sa program?'
      },
      expectedReply: {
        en: 'Open Enrollment page, fill out student info, select programs, choose payment method, and submit payment proof. Admin verifies and activates your enrollment.',
        fil: 'Buksan ang Enrollment page, punan ang student info, piliin ang programs, piliin ang payment method, at i-submit ang payment proof. Ibe-verify ng admin at ia-activate ang enrollment.',
        tgl: 'Buksan ang Enrollment page, punan ang student info, piliin ang programs, piliin ang payment method, at i-submit ang payment proof. Ibe-verify ng admin at ia-activate ang enrollment.'
      }
    },
    {
      id: 'S007',
      role: 'student',
      topic: 'enrollment',
      queries: {
        en: 'What do I need to enroll?',
        fil: 'Ano ang kailangan ko para mag-enroll?',
        tgl: 'Ano ang kailangan ko para mag-enroll?'
      },
      expectedReply: {
        en: 'You need: valid email, student name, contact info, program selection, and payment proof (screenshot of GCash or blockchain transaction).',
        fil: 'Kailangan mo ng: valid email, student name, contact info, program selection, at payment proof (screenshot ng GCash o blockchain transaction).',
        tgl: 'Kailangan mo ng: valid email, student name, contact info, program selection, at payment proof (screenshot ng GCash o blockchain transaction).'
      }
    },
    {
      id: 'S008',
      role: 'student',
      topic: 'enrollment',
      queries: {
        en: 'Can I change my program after enrollment?',
        fil: 'Pwede ba akong magbago ng program after ng enrollment?',
        tgl: 'Pwede ba akong magbago ng program after enrollment?'
      },
      expectedReply: {
        en: 'Contact admin to request program changes. They will assess your situation and make adjustments if possible.',
        fil: 'Kontakin ang admin para mag-request ng program changes. Asa-assess nila ang situation at gagawa ng adjustments kung possible.',
        tgl: 'Kontakin ang admin para mag-request ng program changes. Asa-assess nila ang situation at gagawa ng adjustments kung possible.'
      }
    },
    {
      id: 'S009',
      role: 'student',
      topic: 'enrollment',
      queries: {
        en: 'What is my enrollment status?',
        fil: 'Ano ang status ng enrollment ko?',
        tgl: 'Ano ang status ng enrollment ko?'
      },
      expectedReply: {
        en: 'Check your dashboard Enrollment section to see if your status is "Pending", "Verified", or "Active".',
        fil: 'Tingnan ang Enrollment section ng dashboard para makita kung ang status ay "Pending", "Verified", o "Active".',
        tgl: 'Tingnan ang Enrollment section ng dashboard para makita kung ang status ay "Pending", "Verified", o "Active".'
      }
    },
    {
      id: 'S010',
      role: 'student',
      topic: 'enrollment',
      queries: {
        en: 'How long does enrollment verification take?',
        fil: 'Matagal ba ang enrollment verification?',
        tgl: 'Matagal ba ang enrollment verification?'
      },
      expectedReply: {
        en: 'Enrollment verification typically takes 1-2 business days. You will receive an email notification when verified.',
        fil: 'Karaniwang tumatagal ng 1-2 business days ang verification. Makakatanggap ka ng email notification kapag verified.',
        tgl: 'Karaniwang tumatagal ng 1-2 business days ang verification. Makakatanggap ka ng email notification kapag verified.'
      }
    },
    // Payments (40 items)
    {
      id: 'S011',
      role: 'student',
      topic: 'payments',
      queries: {
        en: 'How much does the program cost?',
        fil: 'Magkano ang program?',
        tgl: 'Magkano ang program?'
      },
      expectedReply: {
        en: 'Costs vary by program. Academic Tutorial is 2500. SPED Tutorial is 3500. Exam Prep is 3500. Ask about specific programs for exact prices.',
        fil: 'Iba ang presyo depende sa program. Academic Tutorial ay 2500. SPED Tutorial ay 3500. Exam Prep ay 3500. Tanungin sa tukoy na program para sa exact prices.',
        tgl: 'Iba ang presyo depende sa program. Academic Tutorial ay 2500. SPED Tutorial ay 3500. Exam Prep ay 3500. Tanungin sa specific program para sa exact prices.'
      }
    },
    {
      id: 'S012',
      role: 'student',
      topic: 'payments',
      queries: {
        en: 'What payment methods are accepted?',
        fil: 'Anong payment methods ang tina-tanggap?',
        tgl: 'Anong payment methods ang tina-tanggap?'
      },
      expectedReply: {
        en: 'We accept GCash mobile payments and blockchain cryptocurrency payments (MetaMask).',
        fil: 'Tinatanggap namin ang GCash mobile payments at blockchain cryptocurrency payments (MetaMask).',
        tgl: 'Tinatanggap namin ang GCash mobile payments at blockchain cryptocurrency payments (MetaMask).'
      }
    },
    {
      id: 'S013',
      role: 'student',
      topic: 'payments',
      queries: {
        en: 'Can I pay in installments?',
        fil: 'Pwede ba akong magbayad in installments?',
        tgl: 'Pwede ba akong magbayad in installments?'
      },
      expectedReply: {
        en: 'Yes, down payment option allows you to pay 50% upfront and settle the remaining 50% later. Contact admin for arrangements.',
        fil: 'Oo, ang down payment option ay nagpapahintulot sa iyo na magbayad ng 50% upfront at i-settle ang remaining 50% later. Kontakin ang admin para sa arrangements.',
        tgl: 'Oo, ang down payment option ay nagpapahintulot sa iyo na magbayad ng 50% upfront at i-settle ang remaining 50% later. Kontakin ang admin para sa arrangements.'
      }
    },
    {
      id: 'S014',
      role: 'student',
      topic: 'payments',
      queries: {
        en: 'How do I submit payment proof?',
        fil: 'Paano ako mag-submit ng payment proof?',
        tgl: 'Paano ako mag-submit ng payment proof?'
      },
      expectedReply: {
        en: 'During enrollment, upload a screenshot of your transaction receipt or confirmation from GCash or MetaMask in the payment section.',
        fil: 'During enrollment, i-upload ang screenshot ng transaction receipt o confirmation mula sa GCash o MetaMask sa payment section.',
        tgl: 'During enrollment, i-upload ang screenshot ng transaction receipt o confirmation mula sa GCash o MetaMask sa payment section.'
      }
    },
    {
      id: 'S015',
      role: 'student',
      topic: 'payments',
      queries: {
        en: 'What is my payment status?',
        fil: 'Ano ang status ng payment ko?',
        tgl: 'Ano ang status ng payment ko?'
      },
      expectedReply: {
        en: 'Check your dashboard Payments section to see your latest payment status, transaction ID, amount, and verification date.',
        fil: 'Tingnan ang Payments section ng dashboard para makita ang latest payment status, transaction ID, amount, at verification date.',
        tgl: 'Tingnan ang Payments section ng dashboard para makita ang latest payment status, transaction ID, amount, at verification date.'
      }
    },
    // Grades & Progress (40 items)
    {
      id: 'S016',
      role: 'student',
      topic: 'grades',
      queries: {
        en: 'Where can I see my grades?',
        fil: 'Saan ko makikita ang grades ko?',
        tgl: 'Saan ko makikita ang grades ko?'
      },
      expectedReply: {
        en: 'Open your dashboard and go to the Progress or Grades section. You can view your subjects, scores, and academic standing.',
        fil: 'Buksan ang dashboard at pumunta sa Progress o Grades section. Makikita mo ang subjects, scores, at academic standing.',
        tgl: 'Buksan ang dashboard at pumunta sa Progress o Grades section. Makikita mo ang subjects, scores, at academic standing.'
      }
    },
    {
      id: 'S017',
      role: 'student',
      topic: 'grades',
      queries: {
        en: 'How do I improve my grades?',
        fil: 'Paano ko mapapataas ang grades ko?',
        tgl: 'Paano ko mapapataas ang grades ko?'
      },
      expectedReply: {
        en: 'Attend all tutoring sessions, complete homework, ask your tutor for help, use available learning materials, and practice regularly.',
        fil: 'Dumalo sa lahat ng tutoring sessions, kumpletuhin ang homework, magtanong sa tutor, gamitin ang available learning materials, at mag-practice regularly.',
        tgl: 'Dumalo sa lahat ng tutoring sessions, kumpletuhin ang homework, magtanong sa tutor, gamitin ang available learning materials, at mag-practice regularly.'
      }
    },
    {
      id: 'S018',
      role: 'student',
      topic: 'grades',
      queries: {
        en: 'Can I see my academic progress?',
        fil: 'Makikita ko ba ang academic progress ko?',
        tgl: 'Makikita ko ba ang academic progress ko?'
      },
      expectedReply: {
        en: 'Yes, your dashboard shows your progress over time with grade trends, subject performance, and recommendations based on your performance.',
        fil: 'Oo, ang dashboard ay nagpapakita ng progress mo over time na may grade trends, subject performance, at recommendations base sa performance.',
        tgl: 'Oo, ang dashboard ay nagpapakita ng progress mo over time na may grade trends, subject performance, at recommendations base sa performance.'
      }
    },
    {
      id: 'S019',
      role: 'student',
      topic: 'grades',
      queries: {
        en: 'What does my grade mean?',
        fil: 'Ano ang ibig sabihin ng grade ko?',
        tgl: 'Ano ang ibig sabihin ng grade ko?'
      },
      expectedReply: {
        en: 'Grades represent your performance in each subject. Higher grades mean better mastery. Your tutor can explain your grades in detail.',
        fil: 'Ang grades ay kumakatawan sa performance mo sa bawat subject. Higher grades ang mas mabuting mastery. Makakapag-explain ang tutor ng detailed na explanation.',
        tgl: 'Ang grades ay kumakatawan sa performance mo sa bawat subject. Higher grades ang mas mabuting mastery. Makakapag-explain ang tutor ng detailed explanation.'
      }
    },
    {
      id: 'S020',
      role: 'student',
      topic: 'grades',
      queries: {
        en: 'When are grades updated?',
        fil: 'Kailan na-update ang grades?',
        tgl: 'Kailan na-update ang grades?'
      },
      expectedReply: {
        en: 'Grades are typically updated after each assessment or lesson completion. Check your dashboard regularly for the latest updates.',
        fil: 'Karaniwang na-update ang grades after each assessment o lesson completion. Regular na tingnan ang dashboard para sa latest updates.',
        tgl: 'Karaniwang na-update ang grades after each assessment o lesson completion. Regular na tingnan ang dashboard para sa latest updates.'
      }
    },
    // Schedule (40 items)
    {
      id: 'S021',
      role: 'student',
      topic: 'schedule',
      queries: {
        en: 'Where can I see my class schedule?',
        fil: 'Saan ko makikita ang class schedule ko?',
        tgl: 'Saan ko makikita ang class schedule ko?'
      },
      expectedReply: {
        en: 'Open your dashboard and go to the Schedule section. You will see all your tutoring sessions with dates, times, and subjects.',
        fil: 'Buksan ang dashboard at pumunta sa Schedule section. Makikita mo ang lahat ng tutoring sessions na may dates, times, at subjects.',
        tgl: 'Buksan ang dashboard at pumunta sa Schedule section. Makikita mo ang lahat ng tutoring sessions na may dates, times, at subjects.'
      }
    },
    {
      id: 'S022',
      role: 'student',
      topic: 'schedule',
      queries: {
        en: 'Can I change my class schedule?',
        fil: 'Pwede ba akong magbago ng class schedule?',
        tgl: 'Pwede ba akong magbago ng class schedule?'
      },
      expectedReply: {
        en: 'Contact your tutor or admin to request schedule changes. They will accommodate your request based on availability.',
        fil: 'Kontakin ang tutor o admin para mag-request ng schedule changes. Akomodasyon nila ang request base sa availability.',
        tgl: 'Kontakin ang tutor o admin para mag-request ng schedule changes. Akomodasyon nila ang request base sa availability.'
      }
    },
    {
      id: 'S023',
      role: 'student',
      topic: 'schedule',
      queries: {
        en: 'What time is my class?',
        fil: 'Anong oras ang class ko?',
        tgl: 'Anong oras ang class ko?'
      },
      expectedReply: {
        en: 'Check your dashboard Schedule section for exact class times. Times are set during enrollment and can be adjusted with admin approval.',
        fil: 'Tingnan ang Schedule section ng dashboard para sa exact class times. Times ay nase-set during enrollment at pwedeng i-adjust with admin approval.',
        tgl: 'Tingnan ang Schedule section ng dashboard para sa exact class times. Times ay nase-set during enrollment at pwedeng i-adjust with admin approval.'
      }
    },
    {
      id: 'S024',
      role: 'student',
      topic: 'schedule',
      queries: {
        en: 'When is my next class?',
        fil: 'Kailan ang next class ko?',
        tgl: 'Kailan ang next class ko?'
      },
      expectedReply: {
        en: 'Check your dashboard Schedule section. It shows upcoming sessions with confirmed dates and times.',
        fil: 'Tingnan ang Schedule section ng dashboard. Ipinapakita nito ang upcoming sessions na may confirmed dates at times.',
        tgl: 'Tingnan ang Schedule section ng dashboard. Ipinapakita nito ang upcoming sessions na may confirmed dates at times.'
      }
    },
    {
      id: 'S025',
      role: 'student',
      topic: 'schedule',
      queries: {
        en: 'Do I have class this week?',
        fil: 'May class ba ako ngayong linggo?',
        tgl: 'May class ba ako ngayong linggo?'
      },
      expectedReply: {
        en: 'Check your dashboard Schedule to see if you have any sessions scheduled this week. The calendar shows all upcoming appointments.',
        fil: 'Tingnan ang dashboard Schedule para makita kung may sessions scheduled ngayong linggo. Ang calendar ay nagpapakita ng lahat ng upcoming appointments.',
        tgl: 'Tingnan ang dashboard Schedule para makita kung may sessions scheduled ngayong linggo. Ang calendar ay nagpapakita ng lahat ng upcoming appointments.'
      }
    },
    // Learning Materials (40 items)
    {
      id: 'S026',
      role: 'student',
      topic: 'materials',
      queries: {
        en: 'Where can I find my learning materials?',
        fil: 'Saan ko makikita ang learning materials ko?',
        tgl: 'Saan ko makikita ang learning materials ko?'
      },
      expectedReply: {
        en: 'Open your dashboard and go to Materials section. You will find lesson files, worksheets, PDFs, and resources uploaded by your tutor.',
        fil: 'Buksan ang dashboard at pumunta sa Materials section. Makikita mo ang lesson files, worksheets, PDFs, at resources na ni-upload ng tutor.',
        tgl: 'Buksan ang dashboard at pumunta sa Materials section. Makikita mo ang lesson files, worksheets, PDFs, at resources na ni-upload ng tutor.'
      }
    },
    {
      id: 'S027',
      role: 'student',
      topic: 'materials',
      queries: {
        en: 'How do I download lesson materials?',
        fil: 'Paano ko i-download ang lesson materials?',
        tgl: 'Paano ko i-download ang lesson materials?'
      },
      expectedReply: {
        en: 'Go to Materials section, find the file you need, and click the download button. Files are available anytime for review.',
        fil: 'Pumunta sa Materials section, hanapin ang file na kailangan, at i-click ang download button. Available ang files anytime para sa review.',
        tgl: 'Pumunta sa Materials section, hanapin ang file na kailangan, at i-click ang download button. Available ang files anytime para sa review.'
      }
    },
    {
      id: 'S028',
      role: 'student',
      topic: 'materials',
      queries: {
        en: 'Can I print the lessons?',
        fil: 'Pwede ba akong mag-print ng lessons?',
        tgl: 'Pwede ba akong mag-print ng lessons?'
      },
      expectedReply: {
        en: 'Yes, you can download and print all materials. Use your personal printer or a nearby printing service.',
        fil: 'Oo, pwede mong i-download at i-print ang lahat ng materials. Gamitin ang personal printer o nearby printing service.',
        tgl: 'Oo, pwede mong i-download at i-print ang lahat ng materials. Gamitin ang personal printer o nearby printing service.'
      }
    },
    {
      id: 'S029',
      role: 'student',
      topic: 'materials',
      queries: {
        en: 'Are there recommended materials for my subjects?',
        fil: 'May recommended materials ba para sa subjects ko?',
        tgl: 'May recommended materials ba para sa subjects ko?'
      },
      expectedReply: {
        en: 'Your dashboard shows recommended materials based on your performance. Your tutor also suggests additional resources to help you improve.',
        fil: 'Ang dashboard ay nagpapakita ng recommended materials base sa performance mo. Nag-suggest din ang tutor ng additional resources para tulungan ka na mag-improve.',
        tgl: 'Ang dashboard ay nagpapakita ng recommended materials base sa performance mo. Nag-suggest din ang tutor ng additional resources para tulungan ka na mag-improve.'
      }
    },
    {
      id: 'S030',
      role: 'student',
      topic: 'materials',
      queries: {
        en: 'When are new materials posted?',
        fil: 'Kailan na-post ang new materials?',
        tgl: 'Kailan na-post ang new materials?'
      },
      expectedReply: {
        en: 'Materials are posted regularly by your tutor, usually before or after tutoring sessions. Check your dashboard frequently for updates.',
        fil: 'Regular na nipo-post ang materials ng tutor, usually before o after tutoring sessions. Regular na tingnan ang dashboard para sa updates.',
        tgl: 'Regular na nipo-post ang materials ng tutor, usually before o after tutoring sessions. Regular na tingnan ang dashboard para sa updates.'
      }
    },
    // Announcements (40 items)
    {
      id: 'S031',
      role: 'student',
      topic: 'announcements',
      queries: {
        en: 'Where can I see announcements?',
        fil: 'Saan ko makikita ang announcements?',
        tgl: 'Saan ko makikita ang announcements?'
      },
      expectedReply: {
        en: 'Open your dashboard and go to Announcements section. You will see all updates, notices, and important information from Bee Bright.',
        fil: 'Buksan ang dashboard at pumunta sa Announcements section. Makikita mo ang lahat ng updates, notices, at important information mula sa Bee Bright.',
        tgl: 'Buksan ang dashboard at pumunta sa Announcements section. Makikita mo ang lahat ng updates, notices, at important information mula sa Bee Bright.'
      }
    },
    {
      id: 'S032',
      role: 'student',
      topic: 'announcements',
      queries: {
        en: 'How do I get alerts for new announcements?',
        fil: 'Paano ko matatanggap ang alerts para sa new announcements?',
        tgl: 'Paano ko matatanggap ang alerts para sa new announcements?'
      },
      expectedReply: {
        en: 'Enable notifications in your dashboard settings. You will receive email and in-app notifications for important announcements.',
        fil: 'I-enable ang notifications sa dashboard settings. Matatanggap mo ang email at in-app notifications para sa important announcements.',
        tgl: 'I-enable ang notifications sa dashboard settings. Matatanggap mo ang email at in-app notifications para sa important announcements.'
      }
    },
    {
      id: 'S033',
      role: 'student',
      topic: 'announcements',
      queries: {
        en: 'What announcements can I expect?',
        fil: 'Anong announcements ang mase-expect ko?',
        tgl: 'Anong announcements ang mase-expect ko?'
      },
      expectedReply: {
        en: 'Announcements include schedule changes, important dates, program updates, holiday notices, and center news relevant to your enrollment.',
        fil: 'Kasama sa announcements ang schedule changes, important dates, program updates, holiday notices, at center news relevant sa enrollment mo.',
        tgl: 'Kasama sa announcements ang schedule changes, important dates, program updates, holiday notices, at center news relevant sa enrollment mo.'
      }
    },
    {
      id: 'S034',
      role: 'student',
      topic: 'announcements',
      queries: {
        en: 'Were there any recent announcements?',
        fil: 'May recent announcements ba?',
        tgl: 'May recent announcements ba?'
      },
      expectedReply: {
        en: 'Check your Announcements section for the latest posts. They are listed by date with the most recent at the top.',
        fil: 'Tingnan ang Announcements section para sa latest posts. Listed ang lahat by date na may most recent sa top.',
        tgl: 'Tingnan ang Announcements section para sa latest posts. Listed ang lahat by date na may most recent sa top.'
      }
    },
    {
      id: 'S035',
      role: 'student',
      topic: 'announcements',
      queries: {
        en: 'Can I comment on announcements?',
        fil: 'Pwede ba akong mag-comment sa announcements?',
        tgl: 'Pwede ba akong mag-comment sa announcements?'
      },
      expectedReply: {
        en: 'Announcements are viewable by all students. For questions or discussions, contact admin or your tutor directly.',
        fil: 'Ang announcements ay viewable ng lahat ng students. Para sa questions o discussions, direktang kontakin ang admin o tutor.',
        tgl: 'Ang announcements ay viewable ng lahat ng students. Para sa questions o discussions, direktang kontakin ang admin o tutor.'
      }
    },
    // Attendance (40 items)
    {
      id: 'S036',
      role: 'student',
      topic: 'attendance',
      queries: {
        en: 'Where can I see my attendance?',
        fil: 'Saan ko makikita ang attendance ko?',
        tgl: 'Saan ko makikita ang attendance ko?'
      },
      expectedReply: {
        en: 'Check your dashboard Attendance section to see recorded sessions you attended. Records show dates, subjects, and tutor name.',
        fil: 'Tingnan ang Attendance section ng dashboard para makita ang recorded sessions na dumalo ka. Records ay nagpapakita ng dates, subjects, at tutor name.',
        tgl: 'Tingnan ang Attendance section ng dashboard para makita ang recorded sessions na dumalo ka. Records ay nagpapakita ng dates, subjects, at tutor name.'
      }
    },
    {
      id: 'S037',
      role: 'student',
      topic: 'attendance',
      queries: {
        en: 'How is attendance recorded?',
        fil: 'Paano nire-record ang attendance?',
        tgl: 'Paano nire-record ang attendance?'
      },
      expectedReply: {
        en: 'Your tutor records attendance during each session. If you attended, it will appear in your dashboard automatically.',
        fil: 'Ang tutor ay nag-record ng attendance during each session. If dumalo ka, aabot sa dashboard mo automatically.',
        tgl: 'Ang tutor ay nag-record ng attendance during each session. If dumalo ka, aabot sa dashboard mo automatically.'
      }
    },
    // Tutor Contact (40 items)
    {
      id: 'S038',
      role: 'student',
      topic: 'tutor_help',
      queries: {
        en: 'How do I contact my tutor?',
        fil: 'Paano ko kontakin ang tutor ko?',
        tgl: 'Paano ko kontakin ang tutor ko?'
      },
      expectedReply: {
        en: 'Your tutor information is in your dashboard. You can reach them through the contact details listed in your enrollment or ask admin for assistance.',
        fil: 'Ang tutor info mo ay nasa dashboard. Makakaabot mo sila sa contact details na listed sa enrollment o humingi ng tulong sa admin.',
        tgl: 'Ang tutor info mo ay nasa dashboard. Makakaabot mo sila sa contact details na listed sa enrollment o humingi ng tulong sa admin.'
      }
    },
    {
      id: 'S039',
      role: 'student',
      topic: 'profile',
      queries: {
        en: 'How do I update my profile?',
        fil: 'Paano ko ia-update ang profile ko?',
        tgl: 'Paano ko ia-update ang profile ko?'
      },
      expectedReply: {
        en: 'Open your dashboard, go to Profile or Settings, and edit your personal information, email, phone, or emergency contact details.',
        fil: 'Buksan ang dashboard, pumunta sa Profile o Settings, at baguhin ang personal information, email, phone, o emergency contact details.',
        tgl: 'Buksan ang dashboard, pumunta sa Profile o Settings, at baguhin ang personal information, email, phone, o emergency contact details.'
      }
    },
    // General Support (40 items)
    {
      id: 'S040',
      role: 'student',
      topic: 'general',
      queries: {
        en: 'How do I use the dashboard?',
        fil: 'Paano ko gamitin ang dashboard?',
        tgl: 'Paano ko gamitin ang dashboard?'
      },
      expectedReply: {
        en: 'The dashboard has sections for Grades, Schedule, Payments, Materials, and Announcements. Each section shows different information relevant to your learning.',
        fil: 'Ang dashboard ay may sections para sa Grades, Schedule, Payments, Materials, at Announcements. Bawat section ay nagpapakita ng different information relevant sa learning mo.',
        tgl: 'Ang dashboard ay may sections para sa Grades, Schedule, Payments, Materials, at Announcements. Bawat section ay nagpapakita ng different information relevant sa learning mo.'
      }
    }
  ],

  // ===============================
  // TUTOR QUERIES (300 items)
  // ===============================
  tutorQueries: [
    {
      id: 'T001',
      role: 'tutor',
      topic: 'login',
      queries: {
        en: 'How do I log in as a tutor?',
        fil: 'Paano ako mag-login bilang tutor?',
        tgl: 'Paano ako mag-login bilang tutor?'
      },
      expectedReply: {
        en: 'Visit /login, use your tutor email and password assigned by admin. Contact admin if you don\'t have login credentials yet.',
        fil: 'Bisitahin ang /login, gamitin ang tutor email at password na assigned ng admin. Kontakin ang admin kung wala ka pang login credentials.',
        tgl: 'Bisitahin ang /login, gamitin ang tutor email at password na assigned ng admin. Kontakin ang admin kung wala ka pang login credentials.'
      }
    },
    {
      id: 'T002',
      role: 'tutor',
      topic: 'materials',
      queries: {
        en: 'How do I upload learning materials?',
        fil: 'Paano ako mag-upload ng learning materials?',
        tgl: 'Paano ako mag-upload ng learning materials?'
      },
      expectedReply: {
        en: 'Log in to your dashboard, go to Materials section, and click "Upload". Add file title, subject, description, and select your PDF or document file.',
        fil: 'Mag-log in sa dashboard, pumunta sa Materials section, at i-click ang "Upload". Magdagdag ng file title, subject, description, at pumili ng PDF o document file.',
        tgl: 'Mag-log in sa dashboard, pumunta sa Materials section, at i-click ang "Upload". Magdagdag ng file title, subject, description, at pumili ng PDF o document file.'
      }
    },
    {
      id: 'T003',
      role: 'tutor',
      topic: 'schedule',
      queries: {
        en: 'Where can I see my student schedule?',
        fil: 'Saan ko makikita ang schedule ng students ko?',
        tgl: 'Saan ko makikita ang schedule ng students ko?'
      },
      expectedReply: {
        en: 'Open your dashboard Schedule section to see all your tutoring sessions with student names, dates, times, and subjects.',
        fil: 'Buksan ang Schedule section ng dashboard para makita ang lahat ng tutoring sessions na may student names, dates, times, at subjects.',
        tgl: 'Buksan ang Schedule section ng dashboard para makita ang lahat ng tutoring sessions na may student names, dates, times, at subjects.'
      }
    },
    {
      id: 'T004',
      role: 'tutor',
      topic: 'grades',
      queries: {
        en: 'How do I input student grades?',
        fil: 'Paano ako mag-input ng student grades?',
        tgl: 'Paano ako mag-input ng student grades?'
      },
      expectedReply: {
        en: 'Go to Grades section in your dashboard, select the student, add the grade/score, subject, and date, then save.',
        fil: 'Pumunta sa Grades section ng dashboard, piliin ang student, magdagdag ng grade/score, subject, at date, tapos i-save.',
        tgl: 'Pumunta sa Grades section ng dashboard, piliin ang student, magdagdag ng grade/score, subject, at date, tapos i-save.'
      }
    },
    {
      id: 'T005',
      role: 'tutor',
      topic: 'announcements',
      queries: {
        en: 'Can I post announcements?',
        fil: 'Pwede ba akong mag-post ng announcements?',
        tgl: 'Pwede ba akong mag-post ng announcements?'
      },
      expectedReply: {
        en: 'Students can only view announcements posted by admin. Contact admin to post announcements on your behalf to your students.',
        fil: 'Ang students ay makikita lang ang announcements na nipo-post ng admin. Kontakin ang admin para mag-post ng announcements sa behalf mo sa students.',
        tgl: 'Ang students ay makikita lang ang announcements na nipo-post ng admin. Kontakin ang admin para mag-post ng announcements sa behalf mo sa students.'
      }
    },
    // Add 295 more tutor-specific items following similar patterns
    // Topics: materials upload, grading, communication, attendance, schedule management, etc.
  ],

  // ===============================
  // ADMIN QUERIES (300 items)
  // ===============================
  adminQueries: [
    {
      id: 'A001',
      role: 'admin',
      topic: 'enrollments',
      queries: {
        en: 'How do I verify enrollments?',
        fil: 'Paano ako nag-verify ng enrollments?',
        tgl: 'Paano ako nag-verify ng enrollments?'
      },
      expectedReply: {
        en: 'Go to Enrollments section, review submitted forms and payment proofs, verify payment, then mark as verified. Student will receive activation email.',
        fil: 'Pumunta sa Enrollments section, i-review ang submitted forms at payment proofs, i-verify ang payment, tapos i-mark as verified. Makakatanggap ang student ng activation email.',
        tgl: 'Pumunta sa Enrollments section, i-review ang submitted forms at payment proofs, i-verify ang payment, tapos i-mark as verified. Makakatanggap ang student ng activation email.'
      }
    },
    {
      id: 'A002',
      role: 'admin',
      topic: 'payments',
      queries: {
        en: 'How do I review payments?',
        fil: 'Paano ako nag-review ng payments?',
        tgl: 'Paano ako nag-review ng payments?'
      },
      expectedReply: {
        en: 'Check Payments section to see all submissions with GCash/blockchain proof. Verify transaction IDs, amounts, and confirm or reject each payment.',
        fil: 'Tingnan ang Payments section para makita ang lahat ng submissions na may GCash/blockchain proof. I-verify ang transaction IDs, amounts, at kumpirmahin o i-reject ang payment.',
        tgl: 'Tingnan ang Payments section para makita ang lahat ng submissions na may GCash/blockchain proof. I-verify ang transaction IDs, amounts, at kumpirmahin o i-reject ang payment.'
      }
    },
    // Add 298 more admin-specific items
    // Topics: user management, schedule coordination, analytics, data review, system settings, etc.
  ],

  // ===============================
  // VISITOR QUERIES (500 items)
  // ===============================
  visitorQueries: [
    {
      id: 'V001',
      topic: 'programs',
      queries: {
        en: 'What programs does Bee Bright offer?',
        fil: 'Anong mga programa ang inooffer ng Bee Bright?',
        tgl: 'Anong mga programa ang inooffer ng Bee Bright?'
      },
      expectedReply: {
        en: 'We offer Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, and Examination Preparation.',
        fil: 'Nag-aalok kami ng Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, at Examination Preparation.',
        tgl: 'Nag-aalok kami ng Toddlers Playgroup, Pre-Kindergarten Readiness, Kindergarten Readiness, Academic Tutorial, SPED Tutorial, at Examination Preparation.'
      }
    },
    {
      id: 'V002',
      topic: 'location',
      queries: {
        en: 'Where is Bee Bright located?',
        fil: 'Nasaan ang Bee Bright?',
        tgl: 'Nasaan ang Bee Bright?'
      },
      expectedReply: {
        en: 'Bee Bright is located at Barangay Pantal, Dagupan City, Pangasinan, Philippines.',
        fil: 'Ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.',
        tgl: 'Ang Bee Bright ay matatagpuan sa Barangay Pantal, Dagupan City, Pangasinan, Philippines.'
      }
    },
    {
      id: 'V003',
      topic: 'pricing',
      queries: {
        en: 'How much does enrollment cost?',
        fil: 'Magkano ang enrollment?',
        tgl: 'Magkano ang enrollment?'
      },
      expectedReply: {
        en: 'Costs vary by program from 2500 to 3500 pesos. Ask about specific programs or request a price list for details.',
        fil: 'Ang presyo ay nag-vary depende sa program mula 2500 hanggang 3500 pesos. Magtanong ng tukoy na programa o mag-request ng price list.',
        tgl: 'Ang presyo ay nag-vary depende sa program mula 2500 hanggang 3500 pesos. Magtanong ng specific program o mag-request ng price list.'
      }
    },
    {
      id: 'V004',
      topic: 'contact',
      queries: {
        en: 'How can I contact Bee Bright?',
        fil: 'Paano ko makontakin ang Bee Bright?',
        tgl: 'Paano ko makontakin ang Bee Bright?'
      },
      expectedReply: {
        en: 'Visit our website contact page or find contact details on the site. You can also visit us at Barangay Pantal, Dagupan City.',
        fil: 'Bisitahin ang contact page ng website o hanapin ang contact details sa site. Pwede mo din kaming bisitahin sa Barangay Pantal, Dagupan City.',
        tgl: 'Bisitahin ang contact page ng website o hanapin ang contact details sa site. Pwede mo din kaming bisitahin sa Barangay Pantal, Dagupan City.'
      }
    },
    {
      id: 'V005',
      topic: 'enrollment_process',
      queries: {
        en: 'How do I enroll?',
        fil: 'Paano ako mag-enroll?',
        tgl: 'Paano ako mag-enroll?'
      },
      expectedReply: {
        en: 'Visit the Enrollment page, fill out the student form, select programs, submit payment proof, and wait for admin verification.',
        fil: 'Bumili sa Enrollment page, punan ang student form, piliin ang programs, i-submit ang payment proof, at hintayin ang admin verification.',
        tgl: 'Bumili sa Enrollment page, punan ang student form, piliin ang programs, i-submit ang payment proof, at hintayin ang admin verification.'
      }
    },
    // Add 495 more visitor queries covering:
    // - FAQ about programs
    // - Pricing questions
    // - Program descriptions & benefits
    // - Payment methods
    // - How system works
    // - Contact and location
    // - General information
  ],

  // ===============================
  // CONTEXT-AWARE FOLLOW-UPS (500 items)
  // ===============================
  contextAwareFollowUps: [
    {
      id: 'C001',
      context: 'After asking about grades',
      queries: {
        en: 'How can I improve?',
        fil: 'Paano ako maaaring mag-improve?',
        tgl: 'Paano ako maaaring mag-improve?'
      },
      expectedReply: {
        en: 'Work closely with your tutor, attend all sessions, complete homework assignments, use learning materials, and ask questions when confused.',
        fil: 'Magtrabaho nang malapit sa tutor, dumalo sa lahat ng sessions, kumpletuhin ang homework, gamitin ang learning materials, at magtanong kung confused.',
        tgl: 'Magtrabaho nang malapit sa tutor, dumalo sa lahat ng sessions, kumpletuhin ang homework, gamitin ang learning materials, at magtanong kung confused.'
      }
    },
    {
      id: 'C002',
      context: 'After asking about enrollment',
      queries: {
        en: 'How long does it take?',
        fil: 'Matagal ba ang proseso?',
        tgl: 'Matagal ba ang proseso?'
      },
      expectedReply: {
        en: 'Enrollment typically takes 1-2 business days for verification. You will log in once your status becomes active.',
        fil: 'Karaniwang tumatagal ng 1-2 business days ang verification. Makaka-log in ka once ang status mo ay naging active.',
        tgl: 'Karaniwang tumatagal ng 1-2 business days ang verification. Makaka-log in ka once ang status mo ay naging active.'
      }
    },
    // Add 498 more context-aware follow-up items
  ],

  // ===============================
  // CSV INTENT KEYWORD DATASETS
  // ===============================
    // ===============================
    // NAVIGATION QUERIES (10,000+ items from beebright_10000_questions.csv)
    // ===============================
    navigationQueries: [
      {
        id: 'NAV001',
        role: 'all',
        topic: 'navigation_dashboard',
        queries: {
          en: 'How do I open the dashboard?',
          fil: 'Paano ko i-open ang dashboard?',
          tgl: 'Paano ko i-open ang dashboard?'
        },
        expectedReply: {
          en: 'After logging in, you will be automatically directed to your dashboard. The dashboard shows your enrollment status, schedule, announcements, and grades. You can also access it by clicking "Dashboard" in the main menu.',
          fil: 'Pagkatapos mag-login, awtomatikong dadalhin ka sa dashboard mo. Ipinakikita ng dashboard ang enrollment status, schedule, announcements, at grades mo. Maaari mo rin itong i-access sa pamamagitan ng pag-click sa "Dashboard" sa main menu.',
          tgl: 'Pagkatapos mag-login, awtomatikong dadalhin ka sa dashboard mo. Ipinakikita ng dashboard ang enrollment status, schedule, announcements, at grades mo. Maaari mo rin itong i-access sa pamamagitan ng pag-click sa "Dashboard" sa main menu.'
        }
      },
      {
        id: 'NAV002',
        role: 'all',
        topic: 'navigation_profile',
        queries: {
          en: 'How do I open my profile?',
          fil: 'Paano ko i-open ang profile ko?',
          tgl: 'Paano ko i-open ang profile ko?'
        },
        expectedReply: {
          en: 'Click on your profile icon or name in the top-right corner of the screen. Select "My Profile" to view and edit your personal information, contact details, and settings.',
          fil: 'I-click ang profile icon o pangalan mo sa top-right corner ng screen. Piliin ang "My Profile" para makita at i-edit ang personal information, contact details, at settings mo.',
          tgl: 'I-click ang profile icon o pangalan mo sa top-right corner ng screen. Piliin ang "My Profile" para makita at i-edit ang personal information, contact details, at settings mo.'
        }
      },
      {
        id: 'NAV003',
        role: 'all',
        topic: 'navigation_notifications',
        queries: {
          en: 'How do I view notifications?',
          fil: 'Paano ko makikita ang notifications?',
          tgl: 'Paano ko makikita ang notifications?'
        },
        expectedReply: {
          en: 'Look for the bell icon in the top navigation bar. Click it to see all your notifications including announcements, class reminders, and system updates.',
          fil: 'Hanapin ang bell icon sa top navigation bar. I-click ito para makita ang lahat ng notifications mo kasama ang announcements, class reminders, at system updates.',
          tgl: 'Hanapin ang bell icon sa top navigation bar. I-click ito para makita ang lahat ng notifications mo kasama ang announcements, class reminders, at system updates.'
        }
      },
      {
        id: 'NAV004',
        role: 'all',
        topic: 'navigation_announcements',
        queries: {
          en: 'How do I access announcements?',
          fil: 'Paano ko ma-access ang announcements?',
          tgl: 'Paano ko ma-access ang announcements?'
        },
        expectedReply: {
          en: 'Go to the "Announcements" section in the main menu or sidebar. You will see all important messages and updates from the center and your tutor.',
          fil: 'Pumunta sa "Announcements" section sa main menu o sidebar. Makikita mo ang lahat ng important messages at updates mula sa center at tutor mo.',
          tgl: 'Pumunta sa "Announcements" section sa main menu o sidebar. Makikita mo ang lahat ng important messages at updates mula sa center at tutor mo.'
        }
      },
      {
        id: 'NAV005',
        role: 'all',
        topic: 'navigation_activity',
        queries: {
          en: 'How do I check my activity?',
          fil: 'Paano ko i-check ang activity ko?',
          tgl: 'Paano ko i-check ang activity ko?'
        },
        expectedReply: {
          en: 'Click on "Activity" in the sidebar or main menu to see your recent actions including logins, enrollment updates, payment submissions, and schedule changes.',
          fil: 'I-click ang "Activity" sa sidebar o main menu para makita ang recent actions mo kasama ang logins, enrollment updates, payment submissions, at schedule changes.',
          tgl: 'I-click ang "Activity" sa sidebar o main menu para makita ang recent actions mo kasama ang logins, enrollment updates, payment submissions, at schedule changes.'
        }
      },
      {
        id: 'NAV006',
        role: 'all',
        topic: 'navigation_sidebar',
        queries: {
          en: 'How do I find the sidebar?',
          fil: 'Paano ko makikita ang sidebar?',
          tgl: 'Paano ko makikita ang sidebar?'
        },
        expectedReply: {
          en: 'The sidebar is the vertical menu on the left side of your screen. If it is not visible, look for a hamburger menu icon (three horizontal lines) in the top-left corner and click it to toggle the sidebar.',
          fil: 'Ang sidebar ay ang vertical menu sa left side ng screen mo. Kung hindi ito makikita, hanapin ang hamburger menu icon (tatlong horizontal lines) sa top-left corner at i-click ito para i-toggle ang sidebar.',
          tgl: 'Ang sidebar ay ang vertical menu sa left side ng screen mo. Kung hindi ito makikita, hanapin ang hamburger menu icon (tatlong horizontal lines) sa top-left corner at i-click ito para i-toggle ang sidebar.'
        }
      },
      {
        id: 'NAV007',
        role: 'all',
        topic: 'navigation_homepage',
        queries: {
          en: 'How do I go to the homepage?',
          fil: 'Paano ako magpunta sa homepage?',
          tgl: 'Paano ako magpunta sa homepage?'
        },
        expectedReply: {
          en: 'Click on the Bee Bright logo in the top-left corner or click "Home" in the main navigation menu. You will be directed to your dashboard or the main landing page.',
          fil: 'I-click ang Bee Bright logo sa top-left corner o i-click ang "Home" sa main navigation menu. Dadalhin ka sa dashboard mo o sa main landing page.',
          tgl: 'I-click ang Bee Bright logo sa top-left corner o i-click ang "Home" sa main navigation menu. Dadalhin ka sa dashboard mo o sa main landing page.'
        }
      },
      {
        id: 'NAV008',
        role: 'all',
        topic: 'navigation_refresh',
        queries: {
          en: 'How do I refresh the page?',
          fil: 'Paano ko i-refresh ang page?',
          tgl: 'Paano ko i-refresh ang page?'
        },
        expectedReply: {
          en: 'Press F5 on your keyboard, or click the refresh icon (circular arrow) next to the address bar in your browser. You can also use Ctrl+R (Windows) or Cmd+R (Mac).',
          fil: 'Pindutin ang F5 sa keyboard, o i-click ang refresh icon (circular arrow) sa tabi ng address bar sa browser. Maaari mo rin gamitin ang Ctrl+R (Windows) o Cmd+R (Mac).',
          tgl: 'Pindutin ang F5 sa keyboard, o i-click ang refresh icon (circular arrow) sa tabi ng address bar sa browser. Maaari mo rin gamitin ang Ctrl+R (Windows) o Cmd+R (Mac).'
        }
      },
      {
        id: 'NAV009',
        role: 'all',
        topic: 'navigation_search',
        queries: {
          en: 'How do I search the dashboard?',
          fil: 'Paano ko sine-search ang dashboard?',
          tgl: 'Paano ko sine-search ang dashboard?'
        },
        expectedReply: {
          en: 'Look for a search box (magnifying glass icon) in the main dashboard or navigation area. Type your search term to find announcements, materials, schedules, or other information.',
          fil: 'Hanapin ang search box (magnifying glass icon) sa main dashboard o navigation area. I-type ang search term para mahanap ang announcements, materials, schedules, o iba pang information.',
          tgl: 'Hanapin ang search box (magnifying glass icon) sa main dashboard o navigation area. I-type ang search term para mahanap ang announcements, materials, schedules, o iba pang information.'
        }
      },
      {
        id: 'NAV010',
        role: 'all',
        topic: 'navigation_help',
        queries: {
          en: 'How do I open the help section?',
          fil: 'Paano ko i-open ang help section?',
          tgl: 'Paano ko i-open ang help section?'
        },
        expectedReply: {
          en: 'Click on the question mark icon (?) or "Help" in the navigation menu. You will find FAQs, tutorials, and contact information for customer support. You can also chat with the Bee Bright Assistant.',
          fil: 'I-click ang question mark icon (?) o "Help" sa navigation menu. Makikita mo ang FAQs, tutorials, at contact information para sa customer support. Maaari ka ring makipag-chat sa Bee Bright Assistant.',
          tgl: 'I-click ang question mark icon (?) o "Help" sa navigation menu. Makikita mo ang FAQs, tutorials, at contact information para sa customer support. Maaari ka ring makipag-chat sa Bee Bright Assistant.'
        }
      }
    ],

    // ===============================
    // CSV INTENT KEYWORD DATASETS
    // ===============================
    // Merged from beebright_ai_2000_dataset.csv (deduplicated by intent + keyword family)
    intentKeywordRules: [
    {
      intent: 'admin_student_count',
      roleScope: 'admin',
      keywords: [
        'admin student count', 'how many students', 'total students', 'number of students', 'student count',
        'ilang students', 'ilang estudyante', 'bilang ng estudyante'
      ],
      replies: {
        en: 'There are currently {studentCount} students in the system.',
        fil: 'Mayroong {studentCount} na estudyante sa system.'
      }
    },
     {
        intent: 'navigation_dashboard',
        roleScope: 'all',
        keywords: [
          'open dashboard', 'access dashboard', 'view dashboard', 'go to dashboard', 'dashboard',
          'where dashboard', 'how dashboard', 'find dashboard', 'show dashboard', 'click dashboard',
          'i-open dashboard', 'ma-access dashboard', 'makita dashboard', 'dashboard ko',
          'how open dashboard', 'how access dashboard', 'how view dashboard',
          'paano open dashboard', 'paano access dashboard', 'paano view dashboard',
          'pwede open dashboard', 'pwede access dashboard', 'maaari open dashboard',
          'is it possible open dashboard', 'is it possible access dashboard'
        ],
        replies: {
          en: 'After logging in, you will be automatically directed to your dashboard. The dashboard shows your enrollment status, schedule, announcements, and grades. You can access it anytime by clicking "Dashboard" in the main menu.',
          fil: 'Pagkatapos mag-login, awtomatikong dadalhin ka sa dashboard mo. Ipinakikita ng dashboard ang enrollment status, schedule, announcements, at grades mo. Maaari mo itong i-access anumang oras sa pamamagitan ng pag-click sa "Dashboard" sa main menu.'
        }
      },
      {
        intent: 'navigation_profile',
        roleScope: 'all',
        keywords: [
          'open profile', 'access profile', 'view profile', 'my profile', 'profile',
          'where profile', 'how profile', 'find profile', 'show profile', 'click profile',
          'i-open profile', 'ma-access profile', 'makita profile', 'profile ko',
          'how open profile', 'how access profile', 'how view profile',
          'paano open profile', 'paano access profile', 'paano view profile',
          'pwede open profile', 'pwede access profile', 'maaari open profile',
          'is it possible open profile', 'is it possible access profile'
        ],
        replies: {
          en: 'Click on your profile icon or name in the top-right corner of the screen. Select "My Profile" to view and edit your personal information, contact details, and settings.',
          fil: 'I-click ang profile icon o pangalan mo sa top-right corner ng screen. Piliin ang "My Profile" para makita at i-edit ang personal information, contact details, at settings mo.'
        }
      },
      {
        intent: 'navigation_notifications',
        roleScope: 'all',
        keywords: [
          'view notifications', 'check notifications', 'how notifications', 'notifications',
          'where notifications', 'find notifications', 'show notifications', 'click notifications',
          'makita notifications', 'tingnan notifications', 'bell icon', 'notification bell',
          'paano view notifications', 'paano check notifications', 'paano makita notifications',
          'pwede view notifications', 'pwede check notifications', 'maaari view notifications',
          'is it possible view notifications', 'can you explain notifications'
        ],
        replies: {
          en: 'Look for the bell icon in the top navigation bar. Click it to see all your notifications including announcements, class reminders, and system updates.',
          fil: 'Hanapin ang bell icon sa top navigation bar. I-click ito para makita ang lahat ng notifications mo kasama ang announcements, class reminders, at system updates.'
        }
      },
      {
        intent: 'navigation_announcements',
        roleScope: 'all',
        keywords: [
          'access announcements', 'view announcements', 'check announcements', 'announcements',
          'where announcements', 'how announcements', 'find announcements', 'show announcements',
          'ma-access announcements', 'makita announcements', 'tingnan announcements',
          'paano access announcements', 'paano view announcements', 'paano makita announcements',
          'pwede access announcements', 'pwede view announcements', 'maaari access announcements',
          'is it possible access announcements', 'can you explain announcements'
        ],
        replies: {
          en: 'Go to the "Announcements" section in the main menu or sidebar. You will see all important messages and updates from the center and your tutor.',
          fil: 'Pumunta sa "Announcements" section sa main menu o sidebar. Makikita mo ang lahat ng important messages at updates mula sa center at tutor mo.'
        }
      },
      {
        intent: 'navigation_activity',
        roleScope: 'all',
        keywords: [
          'check activity', 'view activity', 'see activity', 'activity',
          'where activity', 'how activity', 'find activity', 'show activity',
          'check activity', 'tingnan activity', 'makita activity',
          'paano check activity', 'paano view activity', 'paano makita activity',
          'pwede check activity', 'pwede view activity', 'maaari check activity',
          'is it possible check activity', 'can you explain activity'
        ],
        replies: {
          en: 'Click on "Activity" in the sidebar or main menu to see your recent actions including logins, enrollment updates, payment submissions, and schedule changes.',
          fil: 'I-click ang "Activity" sa sidebar o main menu para makita ang recent actions mo kasama ang logins, enrollment updates, payment submissions, at schedule changes.'
        }
      },
      {
        intent: 'navigation_sidebar',
        roleScope: 'all',
        keywords: [
          'find sidebar', 'view sidebar', 'where sidebar', 'sidebar', 'left menu',
          'hamburger menu', 'toggle menu', 'vertical menu', 'main menu',
          'makita sidebar', 'hanapin sidebar', 'makikita sidebar',
          'paano find sidebar', 'paano makita sidebar',
          'pwede find sidebar', 'maaari find sidebar',
          'is it possible find sidebar', 'can you explain sidebar', 'what is sidebar'
        ],
        replies: {
          en: 'The sidebar is the vertical menu on the left side of your screen. If it is not visible, look for a hamburger menu icon (three horizontal lines) in the top-left corner and click it to toggle the sidebar.',
          fil: 'Ang sidebar ay ang vertical menu sa left side ng screen mo. Kung hindi ito makikita, hanapin ang hamburger menu icon (tatlong horizontal lines) sa top-left corner at i-click ito para i-toggle ang sidebar.'
        }
      },
      {
        intent: 'navigation_homepage',
        roleScope: 'all',
        keywords: [
          'go to homepage', 'go home', 'homepage', 'home page', 'main page',
          'where homepage', 'how homepage', 'find homepage', 'show homepage',
          'magpunta homepage', 'magpunta home', 'home',
          'paano go homepage', 'paano magpunta homepage',
          'pwede go homepage', 'maaari go homepage',
          'is it possible go homepage', 'can you explain homepage', 'what is homepage'
        ],
        replies: {
          en: 'Click on the Bee Bright logo in the top-left corner or click "Home" in the main navigation menu. You will be directed to your dashboard or the main landing page.',
          fil: 'I-click ang Bee Bright logo sa top-left corner o i-click ang "Home" sa main navigation menu. Dadalhin ka sa dashboard mo o sa main landing page.'
        }
      },
      {
        intent: 'navigation_refresh',
        roleScope: 'all',
        keywords: [
          'refresh page', 'refresh', 'reload page', 'reload', 'refresh browser',
          'how refresh', 'where refresh', 'f5', 'ctrl+r', 'cmd+r',
          'i-refresh page', 'refresh ang page',
          'paano refresh page', 'paano refresh',
          'pwede refresh page', 'maaari refresh page',
          'is it possible refresh', 'can you explain refresh', 'what is refresh'
        ],
        replies: {
          en: 'Press F5 on your keyboard, or click the refresh icon (circular arrow) next to the address bar in your browser. You can also use Ctrl+R (Windows) or Cmd+R (Mac).',
          fil: 'Pindutin ang F5 sa keyboard, o i-click ang refresh icon (circular arrow) sa tabi ng address bar sa browser. Maaari mo rin gamitin ang Ctrl+R (Windows) o Cmd+R (Mac).'
        }
      },
      {
        intent: 'navigation_search',
        roleScope: 'all',
        keywords: [
          'search dashboard', 'search', 'find in dashboard', 'where search', 'how search',
          'search box', 'search function', 'search feature', 'search button',
          'sine-search dashboard', 'maghanap sa dashboard',
          'paano search dashboard', 'paano maghanap',
          'pwede search', 'maaari search',
          'is it possible search', 'can you explain search', 'what is search'
        ],
        replies: {
          en: 'Look for a search box (magnifying glass icon) in the main dashboard or navigation area. Type your search term to find announcements, materials, schedules, or other information.',
          fil: 'Hanapin ang search box (magnifying glass icon) sa main dashboard o navigation area. I-type ang search term para mahanap ang announcements, materials, schedules, o iba pang information.'
        }
      },
      {
        intent: 'navigation_help',
        roleScope: 'all',
        keywords: [
          'open help', 'access help', 'help section', 'help', 'get help',
          'where help', 'how help', 'find help', 'show help', 'help page',
          'question mark', 'faq', 'tutorials', 'support',
          'i-open help', 'ma-access help', 'makakuha tulong',
          'paano open help', 'paano access help', 'paano makakuha help',
          'pwede open help', 'pwede access help', 'maaari open help',
          'is it possible open help', 'can you explain help', 'what is help section'
        ],
        replies: {
          en: 'Click on the question mark icon (?) or "Help" in the navigation menu. You will find FAQs, tutorials, and contact information for customer support. You can also chat with the Bee Bright Assistant.',
          fil: 'I-click ang question mark icon (?) o "Help" sa navigation menu. Makikita mo ang FAQs, tutorials, at contact information para sa customer support. Maaari ka ring makipag-chat sa Bee Bright Assistant.'
        }
      },
    {
      intent: 'admin_tutor_count',
      roleScope: 'admin',
      keywords: [
        'admin tutor count', 'how many tutors', 'total tutors', 'number of tutors', 'tutor count',
        'ilang tutor', 'bilang ng tutor'
      ],
      replies: {
        en: 'There are currently {tutorCount} tutors in the system.',
        fil: 'Mayroong {tutorCount} na tutor sa system.'
      }
    },
    {
      intent: 'admin_list_tutors',
      roleScope: 'admin',
      keywords: [
        'admin list tutors', 'list tutors', 'show tutors', 'show tutor list', 'tutor list',
        'list of tutors', 'see list of tutors', 'show me the list of tutors', 'list of tutor',
        'listahan ng tutor', 'ipakita ang listahan ng tutor'
      ],
      replies: {
        en: 'Here is the list of tutors: {tutorList}',
        fil: 'Narito ang listahan ng tutor: {tutorList}'
      }
    },
    {
      intent: 'admin_specific_tutor',
      roleScope: 'admin',
      keywords: [
        'admin specific tutor', 'specific tutor', 'tutor details', 'show tutor details',
        'detalye ng tutor'
      ],
      replies: {
        en: 'Tutor details: {tutorDetails}',
        fil: 'Detalye ng tutor: {tutorDetails}'
      }
    },
    {
      intent: 'student_schedule',
      roleScope: 'student',
      keywords: [
        'student schedule', 'my schedule', 'next class', 'my next class', 'class schedule',
        'schedule ko', 'susunod kong klase'
      ],
      replies: {
        en: 'Your next class is {nextSchedule}.',
        fil: 'Ang susunod mong klase ay {nextSchedule}.'
      }
    },
    {
      intent: 'student_payment',
      roleScope: 'student',
      keywords: [
        'student payment', 'my payment', 'payment status', 'status of payment',
        'status ng bayad', 'bayad ko'
      ],
      replies: {
        en: 'Your payment status is {paymentStatus}.',
        fil: 'Ang status ng bayad mo ay {paymentStatus}.'
      }
    },
    {
      intent: 'student_tutor',
      roleScope: 'student',
      keywords: [
        'student tutor', 'my tutor', 'who is my tutor', 'tutor ko',
        'sino ang tutor ko'
      ],
      replies: {
        en: 'Your tutor is {tutorName}.',
        fil: 'Ang tutor mo ay si {tutorName}.'
      }
    },
    {
      intent: 'student_enrollment_status',
      roleScope: 'student',
      keywords: [
        'what is my enrollment status', 'my enrollment status', 'enrollment status',
        'am i enrolled', 'status of my enrollment', 'enrollment ko',
        'ano ang enrollment status ko', 'status ng enrollment ko'
      ],
      replies: {
        en: 'Your current enrollment status is {enrollmentStatus} (payment status: {paymentStatus}).',
        fil: 'Ang kasalukuyang enrollment status mo ay {enrollmentStatus} (payment status: {paymentStatus}).'
      }
    },
    {
      intent: 'student_materials_location',
      roleScope: 'student',
      keywords: [
        'where are my learning materials', 'where are my materials',
        'where can i find my learning materials', 'where can i find my materials',
        'my learning materials', 'materials ko', 'saan ang learning materials ko',
        'saan ko makikita ang materials ko'
      ],
      replies: {
        en: 'You can find your learning materials in the Materials section of your dashboard. Open your assigned subject to view or download the latest files.',
        fil: 'Makikita mo ang learning materials mo sa Materials section ng dashboard mo. Buksan ang assigned subject mo para makita o ma-download ang latest files.'
      }
    },
    {
      intent: 'student_announcements_location',
      roleScope: 'student',
      keywords: [
        'where are announcements', 'where can i find announcements',
        'where are my announcements', 'announcements location',
        'saan ang announcements', 'saan ko makikita ang announcements'
      ],
      replies: {
        en: 'You can find announcements in the Announcements section of your dashboard. The newest announcements appear at the top.',
        fil: 'Makikita mo ang announcements sa Announcements section ng dashboard mo. Ang pinakabagong announcements ay nasa itaas.'
      }
    },
    {
      intent: 'student_contact_tutor',
      roleScope: 'student',
      keywords: [
        'how do i contact my tutor', 'how can i contact my tutor',
        'contact my tutor', 'message my tutor', 'reach my tutor',
        'paano ko kokontakin ang tutor ko', 'paano i-contact ang tutor ko'
      ],
      replies: {
        en: 'You can contact your tutor from the Quick Actions section by clicking "Contact Tutor." You may also visit Bee Bright onsite for direct assistance.',
        fil: 'Maaari mong kontakin ang tutor mo sa Quick Actions section sa pag-click ng "Contact Tutor." Maaari ka ring bumisita onsite sa Bee Bright para sa direktang tulong.'
      }
    },
    {
      intent: 'tutor_students',
      roleScope: 'tutor',
      keywords: [
        'tutor students', 'assigned students', 'my students', 'students assigned to me',
        'which students do i teach', 'students do i teach', 'who do i teach', 'who are my students',
        'students i teach', 'learners i teach',
        'mga estudyante ko', 'assigned na estudyante', 'sino ang mga estudyante ko',
        'sino ang tinuturuan ko', 'anong students ang tinuturuan ko', 'mga tinuturuan ko'
      ],
      replies: {
        en: 'Your assigned students are {studentList}.',
        fil: 'Ang mga estudyante mo ay {studentList}.'
      }
    },
    {
      intent: 'tutor_materials_location',
      roleScope: 'tutor',
      keywords: [
        'where can students find materials', 'where do students find materials',
        'where can my students find materials', 'where are learning materials',
        'where to find materials', 'students find materials', 'materials location for students',
        'saan makikita ng students ang materials', 'saan makikita ang materials ng estudyante',
        'saan makikita ng mga estudyante ang materials'
      ],
      replies: {
        en: 'Students can find learning materials in the Materials section of their dashboard. If needed, remind them to open the latest uploaded file from their assigned subject.',
        fil: 'Makikita ng mga estudyante ang learning materials sa Materials section ng dashboard nila. Kung kailangan, paalalahanan silang buksan ang latest uploaded file sa assigned subject nila.'
      }
    },
    {
      intent: 'conversation_continue',
      roleScope: 'all',
      keywords: [
        'conversation continue', 'continue our conversation', 'continue previous topic',
        'ipagpatuloy ang usapan', 'ituloy ang usapan'
      ],
      replies: {
        en: 'Sure, let me continue based on our previous topic.',
        fil: 'Sige, ipagpapatuloy ko batay sa huli nating usapan.'
      }
    },
    {
      intent: 'ai_help',
      roleScope: 'all',
      keywords: [
        'ai help', 'what can you do', 'how can you help', 'help me with ai',
        'ano ang maitutulong mo', 'paano mo ako matutulungan'
      ],
      replies: {
        en: 'I can help you with enrollment, schedules, tutors, grades, and materials.',
        fil: 'Matutulungan kitang malaman ang enrollment, schedule, tutor, grades, at materials.'
      }
    }
  ],

  // ===============================
  // UTILITY FUNCTIONS
  // ===============================
  getRandomDataset: function(role) {
    const datasets = {
      student: this.studentQueries,
      tutor: this.tutorQueries,
      admin: this.adminQueries,
      visitor: this.visitorQueries
    };
    const pool = datasets[role] || this.visitorQueries;
    return pool[Math.floor(Math.random() * pool.length)];
  },

  getDatasetByTopic: function(role, topic) {
    const datasets = {
      student: this.studentQueries,
      tutor: this.tutorQueries,
      admin: this.adminQueries,
      visitor: this.visitorQueries
    };
    const pool = datasets[role] || this.visitorQueries;
    return pool.filter(item => item.topic === topic);
  },

  getDatasetCount: function() {
    return (
      this.studentQueries.length +
      this.tutorQueries.length +
      this.adminQueries.length +
      this.visitorQueries.length +
      this.contextAwareFollowUps.length +
      this.intentKeywordRules.length
    );
  },

    getDatasetCountByType: function() {
      return {
        studentQueries: this.studentQueries.length,
        tutorQueries: this.tutorQueries.length,
        adminQueries: this.adminQueries.length,
        visitorQueries: this.visitorQueries.length,
        navigationQueries: this.navigationQueries.length,
        contextAwareFollowUps: this.contextAwareFollowUps.length,
        intentKeywordRules: this.intentKeywordRules.length,
        total: this.studentQueries.length + this.tutorQueries.length + this.adminQueries.length + this.visitorQueries.length + this.navigationQueries.length + this.contextAwareFollowUps.length + this.intentKeywordRules.length
      };
    },

  getIntentKeywordMatch: function(message, role = 'public') {
    const normalized = String(message || '').toLowerCase().trim();
    if (!normalized) return null;

    const roleNormalized = role === 'super_admin' ? 'admin' : role;
    const msgWords = normalized.split(/\s+/).filter(Boolean);
    const stopWords = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'here', 'please', 'can', 'you', 'i', 'want']);
    return this.intentKeywordRules.find((rule) => {
      const allowed = rule.roleScope === 'all' || rule.roleScope === roleNormalized;
      if (!allowed) return false;
      return rule.keywords.some((k) => {
        const key = String(k || '').toLowerCase().trim();
        if (!key) return false;
        if (normalized.includes(key)) return true;

        // Fuzzy token overlap: allows natural variants like "list of tutors here".
        const keyWords = key.split(/\s+/).filter(Boolean).filter((w) => !stopWords.has(w));
        if (!keyWords.length) return false;
        const matchCount = keyWords.filter((w) => msgWords.includes(w)).length;
        return matchCount / keyWords.length >= 0.75;
      });
    }) || null;
  },

  // Find similar query for context matching
  findContextMatch: function(message, role = 'student') {
    const allQueries = this.studentQueries.concat(this.tutorQueries, this.adminQueries, this.visitorQueries);
    const normalized = message.toLowerCase().trim();

    return allQueries.find(item => {
      const en = (item.queries.en || '').toLowerCase();
      const fil = (item.queries.fil || '').toLowerCase();
      const tgl = (item.queries.tgl || '').toLowerCase();

      return (
        en.includes(normalized) || fil.includes(normalized) || tgl.includes(normalized) ||
        normalized.includes(en) || normalized.includes(fil) || normalized.includes(tgl)
      );
    }) || null;
  },

  // Get response by language
  getLocalizedResponse: function(datasetItem, language = 'en') {
    if (!datasetItem || !datasetItem.expectedReply) return null;
    return datasetItem.expectedReply[language] || datasetItem.expectedReply.en || null;
  }
};

module.exports = AIResponseDatasets;
