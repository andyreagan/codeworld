      * Premium transaction, as it arrives from the agency feed.
       01  TXN-REC.
           05  TXN-POL-NUMBER      PIC X(10).
           05  TXN-TYPE            PIC X(2).
               88  TXN-NEW-BUSINESS VALUE 'NB'.
               88  TXN-RENEWAL      VALUE 'RN'.
               88  TXN-ENDORSEMENT  VALUE 'EN'.
           05  TXN-AMOUNT          PIC S9(7)V99.
           05  TXN-DUE-DATE        PIC X(8).
           05  FILLER              PIC X(51).
